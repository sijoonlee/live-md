import assert from "node:assert/strict";
import {test} from "node:test";
import {can} from "../../src/authz.js";
import type {Principal} from "../../src/auth.js";
import type {DirectoryDocument} from "../../src/directory.js";

const member = (id: number): Principal => ({id, kind: "human", displayName: `u${id}`, role: "member"});
const admin: Principal = {id: 1, kind: "human", displayName: "root", role: "admin"};

const ownedBy = (ownerId: number | null, id = 500): DirectoryDocument => ({
  id, folderId: 1, name: "doc.md", ownerId, createdAt: "t", updatedAt: "t",
});

// These branches short-circuit before the share-table lookup, so they need no DB.
// The editor/viewer/no-access (shared) branches are covered by the authz e2e.

test("admin may do anything on any document", () => {
  const doc = ownedBy(999);
  for (const action of ["read", "write", "manage"] as const) assert.equal(can(admin, action, doc), true);
});

test("the owner may read, write, and manage their document", () => {
  const doc = ownedBy(42);
  for (const action of ["read", "write", "manage"] as const) assert.equal(can(member(42), action, doc), true);
});

test("an ownerless document fails closed — denied to non-admins, allowed only to admin", () => {
  const doc = ownedBy(null);
  const anyone = member(7);
  assert.equal(can(anyone, "read", doc), false);
  assert.equal(can(anyone, "write", doc), false);
  assert.equal(can(anyone, "manage", doc), false);
  // Admin still bypasses everything.
  assert.equal(can(admin, "read", doc), true);
  assert.equal(can(admin, "manage", doc), true);
});

test("an unauthenticated principal is denied everything", () => {
  const doc = ownedBy(42);
  for (const action of ["read", "write", "manage"] as const) assert.equal(can(undefined, action, doc), false);
});
