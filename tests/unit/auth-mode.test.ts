import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

// Point the shared db dir at a throwaway location before importing the modules
// under test (db.ts reads DATA_DIR at import time).
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "auth-mode-test-"));
const {parseAuthMode, localPrincipal, declaredAgentPrincipal, openModePrincipal} =
  await import("../../src/auth-mode.js");
const {loopbackRejection, resolveBindHost} = await import("../../src/loopback-guard.js");

// --- mode parsing ---------------------------------------------------------
// Anything unrecognised must mean "github": a deployment that fat-fingers the
// variable has to come up secured, never open.

test("parseAuthMode defaults to github for unset and unrecognised values", () => {
  assert.equal(parseAuthMode(undefined), "github");
  assert.equal(parseAuthMode(""), "github");
  assert.equal(parseAuthMode("None"), "github");
  assert.equal(parseAuthMode("off"), "github");
  assert.equal(parseAuthMode("github"), "github");
  assert.equal(parseAuthMode("none"), "none");
});

// --- principals -----------------------------------------------------------

test("localPrincipal is a singleton admin human", () => {
  const first = localPrincipal();
  const second = localPrincipal();
  assert.equal(first.id, second.id);
  assert.equal(first.kind, "human");
  assert.equal(first.role, "admin", "the single local user must see every document");
});

test("declaredAgentPrincipal creates an agent once and reuses it by name", () => {
  const first = declaredAgentPrincipal({"x-agent-id": "claude-code"});
  const second = declaredAgentPrincipal({"x-agent-id": "  claude-code  "});
  assert.equal(first?.kind, "agent");
  assert.equal(first?.displayName, "claude-code");
  assert.equal(second?.id, first?.id, "the same name must not mint a second principal");
});

test("declaredAgentPrincipal ignores absent and unusable agent ids", () => {
  assert.equal(declaredAgentPrincipal({}), undefined);
  assert.equal(declaredAgentPrincipal({"x-agent-id": "   "}), undefined);
  assert.equal(declaredAgentPrincipal({"x-agent-id": "x".repeat(101)}), undefined);
});

test("openModePrincipal prefers a declared agent, else the local user", () => {
  assert.equal(openModePrincipal({"x-agent-id": "editor-bot"}).displayName, "editor-bot");
  assert.equal(openModePrincipal({}).id, localPrincipal().id);
});

// --- bind guardrail -------------------------------------------------------

test("resolveBindHost keeps open mode on loopback and refuses anything else", () => {
  assert.equal(resolveBindHost(undefined, true), "127.0.0.1");
  assert.equal(resolveBindHost("127.0.0.1", true), "127.0.0.1");
  assert.throws(() => resolveBindHost("0.0.0.0", true), /loopback/);
  assert.throws(() => resolveBindHost("192.168.1.10", true), /loopback/);
});

test("resolveBindHost leaves authenticated mode free to bind anywhere", () => {
  assert.equal(resolveBindHost(undefined, false), "0.0.0.0");
  assert.equal(resolveBindHost("0.0.0.0", false), "0.0.0.0");
});

// --- Origin / Host guardrail ---------------------------------------------

test("requests without an Origin pass — agents and curl are not browsers", () => {
  assert.equal(loopbackRejection({host: "localhost:3000"}, 3000), undefined);
  assert.equal(loopbackRejection({host: "127.0.0.1:3000"}, 3000), undefined);
});

test("the app's own origin passes", () => {
  assert.equal(loopbackRejection({host: "localhost:3000", origin: "http://localhost:3000"}, 3000), undefined);
  assert.equal(loopbackRejection({host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000"}, 3000), undefined);
});

test("a web page the user is visiting cannot drive the open server", () => {
  const reason = loopbackRejection({host: "localhost:3000", origin: "https://evil.example"}, 3000);
  assert.match(reason ?? "", /cross-origin/);
});

test("a rebound hostname is refused even though it resolves to loopback", () => {
  const reason = loopbackRejection({host: "attacker.example:3000"}, 3000);
  assert.match(reason ?? "", /Host/);
});

test("an origin on another local port is still cross-origin", () => {
  const reason = loopbackRejection({host: "localhost:3000", origin: "http://localhost:4000"}, 3000);
  assert.match(reason ?? "", /cross-origin/);
});
