import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {parseAllowlist, isAllowed} from "../../src/allowlist.js";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "human-auth-test-"));
const {upsertHumanPrincipal, createSession, getSessionPrincipal, deleteSession} = await import(
  "../../src/human-auth.js"
);

test("parseAllowlist normalizes and isAllowed fails closed on empty", () => {
  assert.deepEqual(parseAllowlist(" Alice, bob@x.com ,, "), ["alice", "bob@x.com"]);
  // Empty allowlist admits no one.
  assert.equal(isAllowed([], "alice", "alice@x.com"), false);
  const allow = parseAllowlist("alice,bob@x.com");
  assert.equal(isAllowed(allow, "Alice", undefined), true); // login match, case-insensitive
  assert.equal(isAllowed(allow, "carol", "BOB@x.com"), true); // email match
  assert.equal(isAllowed(allow, "carol", "carol@x.com"), false);
});

test("upsertHumanPrincipal is idempotent per provider identity", () => {
  const first = upsertHumanPrincipal("github", "12345", "a@x.com", "Alice");
  assert.equal(first.kind, "human");
  const again = upsertHumanPrincipal("github", "12345", "a@x.com", "Alice");
  assert.equal(again.id, first.id);
  // A different subject is a different principal.
  const other = upsertHumanPrincipal("github", "67890", "b@x.com", "Bob");
  assert.notEqual(other.id, first.id);
});

test("sessions resolve to their principal and can be revoked", () => {
  const principal = upsertHumanPrincipal("github", "session-user", "s@x.com", "Sam");
  const {id} = createSession(principal.id);
  assert.equal(getSessionPrincipal(id)?.id, principal.id);
  deleteSession(id);
  assert.equal(getSessionPrincipal(id), undefined);
  assert.equal(getSessionPrincipal(undefined), undefined);
  assert.equal(getSessionPrincipal("nonexistent"), undefined);
});
