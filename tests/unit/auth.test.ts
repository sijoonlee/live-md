import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

// Point the shared db dir at a throwaway location before importing the module
// under test (db.ts reads DATA_DIR at import time).
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "auth-test-"));
const {createAgentPrincipal, createToken, mintAgentToken, verifyToken, listTokens, revokeToken, getPrincipal} =
  await import("../../src/auth.js");

test("createToken returns a volatile plaintext and stores only the hash", () => {
  const agent = createAgentPrincipal("researcher-bot");
  const {token, metadata} = createToken(agent.id, "prod");
  assert.match(token, /^agt_[A-Za-z0-9_-]+$/);
  assert.equal(metadata.principalId, agent.id);
  assert.equal(metadata.name, "prod");

  // The stored metadata never exposes the plaintext.
  const listed = listTokens().find((t) => t.id === metadata.id)!;
  assert.equal(JSON.stringify(listed).includes(token), false);
});

test("verifyToken resolves the principal for a valid token", () => {
  const {token, principal} = mintAgentToken("agent-a");
  const resolved = verifyToken(token);
  assert.equal(resolved?.id, principal.id);
  assert.equal(resolved?.kind, "agent");
  assert.equal(resolved?.displayName, "agent-a");
});

test("verifyToken rejects unknown, malformed, and empty tokens", () => {
  assert.equal(verifyToken("agt_not-a-real-token"), undefined);
  assert.equal(verifyToken(""), undefined);
  assert.equal(verifyToken("garbage"), undefined);
});

test("revokeToken invalidates a token", () => {
  const {token, metadata} = mintAgentToken("agent-b");
  assert.equal(verifyToken(token)?.displayName, "agent-b");
  assert.equal(revokeToken(metadata.id), true);
  assert.equal(verifyToken(token), undefined);
  // Revoking again is a no-op.
  assert.equal(revokeToken(metadata.id), false);
});

test("last_used_at is recorded on first verification", () => {
  const {token, metadata} = mintAgentToken("agent-c");
  assert.equal(listTokens().find((t) => t.id === metadata.id)?.lastUsedAt, null);
  verifyToken(token);
  assert.notEqual(listTokens().find((t) => t.id === metadata.id)?.lastUsedAt, null);
});

test("mintAgentToken creates a fresh agent principal", () => {
  const {principal} = mintAgentToken("agent-d");
  assert.equal(getPrincipal(principal.id)?.displayName, "agent-d");
  assert.equal(getPrincipal(principal.id)?.kind, "agent");
});
