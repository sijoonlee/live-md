import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import * as Y from "yjs";
import {createPersistence} from "../../src/persistence.js";

// Rebuild a document the way the server does on startup: snapshot first, then any
// later updates in revision order.
const rebuild = (state: ReturnType<ReturnType<typeof createPersistence>["load"]>) => {
  const doc = new Y.Doc();
  if (state.snapshot) Y.applyUpdate(doc, state.snapshot);
  for (const entry of state.updates) Y.applyUpdate(doc, entry.update);
  return doc.getText("content").toString();
};

const updateFrom = (mutate: (text: Y.Text) => void, base?: Uint8Array) => {
  const doc = new Y.Doc();
  if (base) Y.applyUpdate(doc, base);
  const before = Y.encodeStateVector(doc);
  mutate(doc.getText("content"));
  return {update: Y.encodeStateAsUpdate(doc, before), state: Y.encodeStateAsUpdate(doc)};
};

test("appended updates replay into the original document", () => {
  const store = createPersistence(new DatabaseSync(":memory:"));
  const first = updateFrom((t) => t.insert(0, "Hello"));
  store.appendUpdate(1, first.update, "agent-a", {reason: "greeting"});
  const second = updateFrom((t) => t.insert(5, " world"), first.state);
  store.appendUpdate(2, second.update, "agent-b");

  const state = store.load();
  assert.equal(state.snapshot, null);
  assert.equal(state.snapshotRevision, 0);
  assert.equal(state.updates.length, 2);
  assert.deepEqual(state.updates[0].metadata, {reason: "greeting"});
  assert.equal(rebuild(state), "Hello world");
});

test("writeSnapshot compacts covered updates and preserves content", () => {
  const store = createPersistence(new DatabaseSync(":memory:"));
  const doc = new Y.Doc();
  const first = updateFrom((t) => t.insert(0, "Hello"));
  store.appendUpdate(1, first.update, "agent-a");
  Y.applyUpdate(doc, first.update);
  const second = updateFrom((t) => t.insert(5, " world"), first.state);
  store.appendUpdate(2, second.update, "agent-b");
  Y.applyUpdate(doc, second.update);

  store.writeSnapshot(Y.encodeStateAsUpdate(doc), 2);
  assert.equal(store.countUpdates(), 0);

  const state = store.load();
  assert.ok(state.snapshot);
  assert.equal(state.snapshotRevision, 2);
  assert.equal(state.updates.length, 0);
  assert.equal(rebuild(state), "Hello world");
});

test("load ignores updates already covered by a later snapshot", () => {
  const store = createPersistence(new DatabaseSync(":memory:"));
  const doc = new Y.Doc();
  const first = updateFrom((t) => t.insert(0, "one"));
  store.appendUpdate(1, first.update, "agent-a");
  Y.applyUpdate(doc, first.update);

  // Snapshot at revision 1, then append a newer update. A stale row at revision 1
  // (as an interrupted compaction would leave) must not replay on top.
  store.writeSnapshot(Y.encodeStateAsUpdate(doc), 1);
  store.appendUpdate(1, first.update, "agent-a"); // simulate leftover stale row
  const second = updateFrom((t) => t.insert(3, " two"), first.state);
  store.appendUpdate(2, second.update, "agent-b");

  const state = store.load();
  assert.equal(state.snapshotRevision, 1);
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].revision, 2);
  assert.equal(rebuild(state), "one two");
});

