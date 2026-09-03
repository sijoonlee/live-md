import type {Principal} from "./auth.js";
import {getShareLevel, type DirectoryDocument} from "./directory.js";

export type Action = "read" | "write" | "manage";

// The single authorization choke point. Every id-scoped document route and the
// WebSocket room join funnels through this one function, so there is exactly one
// place that decides access — no scattered per-handler checks to keep in sync.
// Callers treat a false result as "404, not 403" so existence is not confirmed.
//
// Levels (M21 phase 3 / M14 authorization model):
//   admin  → everything, on every document (bypasses ownership + sharing)
//   owner  → read + write + manage (change the share lists / ownership)
//   editor → read + write
//   viewer → read
//   none   → denied (documents are private by default)
export const can = (
  principal: Principal | undefined,
  action: Action,
  document: DirectoryDocument,
): boolean => {
  if (!principal) return false;
  if (principal.role === "admin") return true;

  // Fail closed on an ownerless document. Every document created through the app has
  // an owner (the creating principal); the app no longer auto-creates a shared,
  // ownerless default. So an ownerless row should not exist — and if one ever did,
  // it must NOT be world-writable. Only an admin (handled above) may touch it.
  if (document.ownerId === null) return false;

  if (document.ownerId === principal.id) return true; // owner: read + write + manage

  // Otherwise the principal needs an explicit per-document level. Agents included:
  // they never inherit their creator's access — only what they are granted here.
  const level = getShareLevel(document.id, principal.id);
  if (level === "editor") return action === "read" || action === "write";
  if (level === "viewer") return action === "read";
  return false; // no access
};
