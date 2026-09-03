import {createAgentPrincipal, getAgentByName, getPrincipal, setPrincipalRole, type Principal} from "./auth.js";
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

// The single local user, created on first use. Global `admin` so it reads and
// writes every document without any share rows — what a single-user install wants,
// and it keeps the sharing model itself untouched.
const LOCAL_PROVIDER = "local";
const LOCAL_SUB = "local";
const LOCAL_NAME = "local";

let cachedLocalId: number | undefined;

export const localPrincipal = (): Principal => {
  if (cachedLocalId !== undefined) {
    const cached = getPrincipal(cachedLocalId);
    if (cached) return cached;
  }
  const principal = upsertHumanPrincipal(LOCAL_PROVIDER, LOCAL_SUB, undefined, LOCAL_NAME);
  if (principal.role !== "admin") setPrincipalRole(principal.id, "admin");
  cachedLocalId = principal.id;
  return getPrincipal(principal.id)!;
};

// With auth off there is nothing to verify, so an agent names itself via
// `X-Agent-Id` and the principal is created on demand. Unverified by design: the
// point is not access control (there is none locally) but attribution, so the
// activity log still records which agent wrote what.
const AGENT_ID_HEADER = "x-agent-id";
const validAgentName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100;

export const declaredAgentPrincipal = (headers: Record<string, unknown>): Principal | undefined => {
  const raw = headers[AGENT_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!validAgentName(value)) return undefined;
  const name = value.trim();
  return getAgentByName(name) ?? createAgentPrincipal(name);
};

// The principal a request resolves to when authentication is disabled: the agent
// it declares itself to be, otherwise the local user.
export const openModePrincipal = (headers: Record<string, unknown>): Principal =>
  declaredAgentPrincipal(headers) ?? localPrincipal();
