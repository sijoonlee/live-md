import {randomBytes} from "node:crypto";
import {database} from "./db.js";
// Importing auth for its side effect guarantees the `principals` table (shared with
// agent auth) exists before the human-identity/session tables reference it.
import "./auth.js";
import {getPrincipal, type Principal} from "./auth.js";

// Human authentication (M14 part B). Humans sign in via GitHub OAuth and hold an
// opaque, server-side session — a random id in an httpOnly cookie, revocable by
// deleting the row (unlike a JWT). Humans are `principals` too, so their identity
// composes with the server-set attribution used for agents.

database.exec(`
  CREATE TABLE IF NOT EXISTS human_identities (
    principal_id INTEGER PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_sub TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(provider, provider_sub)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    principal_id INTEGER NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT
  );
`);

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const now = () => new Date().toISOString();

// Upsert the principal for a provider identity. Keyed on (provider, provider_sub)
// so the same GitHub account always maps to the same principal.
export const upsertHumanPrincipal = (
  provider: string,
  providerSub: string,
  email: string | undefined,
  displayName: string,
): Principal => {
  const existing = database
    .prepare("SELECT principal_id FROM human_identities WHERE provider = ? AND provider_sub = ?")
    .get(provider, providerSub) as {principal_id: number} | undefined;
  if (existing) return getPrincipal(existing.principal_id)!;

  const result = database
    .prepare("INSERT INTO principals (kind, display_name, created_at) VALUES ('human', ?, ?)")
    .run(displayName, now());
  const principalId = Number(result.lastInsertRowid);
  database
    .prepare("INSERT INTO human_identities (principal_id, provider, provider_sub, email, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(principalId, provider, providerSub, email ?? null, now());
  return getPrincipal(principalId)!;
};

export const createSession = (principalId: number): {id: string; expiresAt: string} => {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  database
    .prepare("INSERT INTO sessions (id, principal_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(id, principalId, now(), expiresAt);
  return {id, expiresAt};
};

// Resolve the principal for a session id, or undefined when the session is unknown
// or expired. Refreshes last_seen_at.
export const getSessionPrincipal = (id: string | undefined): Principal | undefined => {
  if (!id) return undefined;
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  if ((row.expires_at as string) <= now()) return undefined;
  database.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now(), id);
  return getPrincipal(row.principal_id as number);
};

export const deleteSession = (id: string | undefined): void => {
  if (id) database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
};
