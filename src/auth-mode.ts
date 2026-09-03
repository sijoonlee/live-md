import {createAgentPrincipal, getAgentByName, getPrincipal, type Principal} from "./auth.js";
import {upsertHumanPrincipal} from "./human-auth.js";

// Optional authentication. live-md normally identifies humans by GitHub OAuth
// session and agents by bearer token; `AUTH_MODE=none` turns that off for the
// single-user local setup (the web UI in a VS Code tab, an agent in the terminal
// beside it), where signing in is pure friction and an OAuth redirect through a
// sandboxed webview is unreliable.
//
// Only *authentication* is optional. `can(principal, action, document)` stays the
// single authorization choke point and every route still receives a real
// Principal, so no handler needs to know which mode is active.

export type AuthMode = "github" | "none";

// Anything unrecognised (including unset) means "github": a deployment that
// forgets the variable comes up secured rather than open.
export const parseAuthMode = (value: string | undefined): AuthMode => (value === "none" ? "none" : "github");

export const authMode: AuthMode = parseAuthMode(process.env.AUTH_MODE);
export const authDisabled = authMode === "none";

// Open mode has no access control to express, so every principal it resolves acts
// as an admin: it reads and writes every document without any share rows, which is
// what a single-user install wants and leaves the sharing model itself untouched.
//
// The elevation is in memory only, never written to the principals table. A
// database used once with AUTH_MODE=none must not come back under AUTH_MODE=github
// carrying a set of admins nobody granted.
const asLocalAdmin = (principal: Principal): Principal => ({...principal, role: "admin"});

// The single local user, created on first use.
const LOCAL_PROVIDER = "local";
const LOCAL_SUB = "local";
const LOCAL_NAME = "local";

let cachedLocalId: number | undefined;

export const localPrincipal = (): Principal => {
  if (cachedLocalId !== undefined) {
    const cached = getPrincipal(cachedLocalId);
    if (cached) return asLocalAdmin(cached);
  }
  const principal = upsertHumanPrincipal(LOCAL_PROVIDER, LOCAL_SUB, undefined, LOCAL_NAME);
  cachedLocalId = principal.id;
  return asLocalAdmin(principal);
};

// With auth off there is nothing to verify, so an agent names itself via
// `X-Agent-Id` and the principal is created on demand. Unverified by design: the
// point is not access control (there is none locally) but attribution, so the
// activity log still records which agent wrote what. It is elevated like the local
// user — naming yourself must not cost you access, or agents would be pushed into
// staying anonymous to get any.
const AGENT_ID_HEADER = "x-agent-id";
const validAgentName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100;

export const declaredAgentPrincipal = (headers: Record<string, unknown>): Principal | undefined => {
  const raw = headers[AGENT_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!validAgentName(value)) return undefined;
  const name = value.trim();
  return asLocalAdmin(getAgentByName(name) ?? createAgentPrincipal(name));
};

// The principal a request resolves to when authentication is disabled: the agent
// it declares itself to be, otherwise the local user.
export const openModePrincipal = (headers: Record<string, unknown>): Principal =>
  declaredAgentPrincipal(headers) ?? localPrincipal();
