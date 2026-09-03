import {createHash, randomBytes} from "node:crypto";
import {database} from "./db.js";

// Authentication primitives shared by the agent-auth (M14 part A) work. Agents
// present an opaque bearer token; the server stores only its SHA-256 hash, so the
// plaintext is volatile — generated in memory at creation, returned once, and never
// persisted. Verifying a token resolves the server-known principal that authored a
// request, which is what lets the server stamp identity instead of trusting a
// client-supplied agentId. Humans are principals too; their auth (sessions) lands
// in M14 part B and reuses the `principals` table.

database.exec(`
  CREATE TABLE IF NOT EXISTS principals (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY,
    principal_id INTEGER NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES principals(id),
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT
  );
`);

// Global system role (M21 phase 3). `admin` bypasses ownership and per-document
// sharing entirely; `member` is the default and is governed only by per-document
// levels. Added by migration so existing databases upgrade in place.
const principalColumns = database.prepare("PRAGMA table_info(principals)").all() as {name: string}[];
if (!principalColumns.some((column) => column.name === "role")) {
  database.exec("ALTER TABLE principals ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
}

export type Role = "admin" | "member";
export type Principal = {id: number; kind: "human" | "agent"; displayName: string; role: Role};
export type TokenMetadata = {
  id: number;
  principalId: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const now = () => new Date().toISOString();
const hashToken = (plaintext: string) => createHash("sha256").update(plaintext).digest("hex");
// Only refresh last_used_at at most this often, so verification is not a write per
// request under load.
const LAST_USED_THROTTLE_MS = 60_000;

const principal = (row: Record<string, unknown>): Principal => ({
  id: row.id as number,
  kind: row.kind as "human" | "agent",
  displayName: row.display_name as string,
  role: (row.role as string) === "admin" ? "admin" : "member",
});

const tokenMetadata = (row: Record<string, unknown>): TokenMetadata => ({
  id: row.id as number,
  principalId: row.principal_id as number,
  name: row.name as string,
  createdAt: row.created_at as string,
  lastUsedAt: (row.last_used_at as string | null) ?? null,
  revokedAt: (row.revoked_at as string | null) ?? null,
});

export const getPrincipal = (id: number): Principal | undefined => {
  const row = database.prepare("SELECT * FROM principals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? principal(row) : undefined;
};

// Resolve an agent by its (assumed-unique) name — used when granting a specific
// agent an access level on a document. Falls back to the lowest id on the unlikely
// event of a duplicate name.
export const getAgentByName = (name: string): Principal | undefined => {
  const row = database.prepare("SELECT * FROM principals WHERE kind = 'agent' AND display_name = ? ORDER BY id LIMIT 1").get(name) as Record<string, unknown> | undefined;
  return row ? principal(row) : undefined;
};

export const setPrincipalRole = (id: number, role: Role): void => {
  database.prepare("UPDATE principals SET role = ? WHERE id = ?").run(role, id);
};

// All principals (humans + agents), for the share picker. Agents appear once even
// if they hold several tokens.
export const listPrincipals = (): Principal[] => {
  const rows = database.prepare("SELECT * FROM principals ORDER BY kind, display_name").all() as Record<string, unknown>[];
  return rows.map(principal);
};

export const createAgentPrincipal = (displayName: string): Principal => {
  const result = database
    .prepare("INSERT INTO principals (kind, display_name, created_at) VALUES ('agent', ?, ?)")
    .run(displayName, now());
  return getPrincipal(Number(result.lastInsertRowid))!;
};

// Create a token for a principal. Returns the plaintext exactly once (it is never
// stored, only its hash) plus the stored metadata.
export const createToken = (
  principalId: number,
  name: string,
  createdBy?: number,
): {token: string; metadata: TokenMetadata} => {
  const plaintext = `agt_${randomBytes(32).toString("base64url")}`;
  const createdAt = now();
  const result = database
    .prepare(
      "INSERT INTO api_tokens (principal_id, created_by, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(principalId, createdBy ?? null, hashToken(plaintext), name, createdAt);
  const row = database.prepare("SELECT * FROM api_tokens WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown>;
  return {token: plaintext, metadata: tokenMetadata(row)};
};

// Convenience for the CLI / "create an agent and its first token" flow.
export const mintAgentToken = (name: string, createdBy?: number) => {
  const agent = createAgentPrincipal(name);
  const {token, metadata} = createToken(agent.id, name, createdBy);
  return {principal: agent, token, metadata};
};

// Resolve the principal a bearer token authenticates, or undefined when the token
// is unknown, revoked, or expired. Refreshes last_used_at (throttled).
export const verifyToken = (plaintext: string): Principal | undefined => {
  if (typeof plaintext !== "string" || plaintext.length === 0) return undefined;
  const row = database.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(hashToken(plaintext)) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  if (row.revoked_at) return undefined;
  if (row.expires_at && (row.expires_at as string) <= now()) return undefined;

  const lastUsed = row.last_used_at as string | null;
  if (!lastUsed || Date.now() - Date.parse(lastUsed) > LAST_USED_THROTTLE_MS) {
    database.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id as number);
  }
  return getPrincipal(row.principal_id as number);
};

export const listTokens = (): TokenMetadata[] => {
  const rows = database
    .prepare("SELECT * FROM api_tokens ORDER BY created_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(tokenMetadata);
};

export const revokeToken = (id: number): boolean => {
  const result = database.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id);
  return result.changes > 0;
};
