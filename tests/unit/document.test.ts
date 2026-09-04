import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import * as Y from "yjs";
import {createPersistence} from "../../src/persistence.js";
import {createLiveDocument} from "../../src/document.js";

const updateInserting = (value: string) => {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return Y.encodeStateAsUpdate(doc);
};

test("two live documents backed by separate streams do not cross-talk", () => {
  const db = new DatabaseSync(":memory:");
  const a = createLiveDocument(createPersistence(db, "1"));
  const b = createLiveDocument(createPersistence(db, "2"));

  a.applyUpdate(updateInserting("hello from A"), "agent-a");
  assert.equal(a.getText(), "hello from A");
  // B is a different document keyed separately: A's edit never reaches it.
  assert.equal(b.getText(), "");

  b.applyUpdate(updateInserting("hello from B"), "agent-b");
  assert.equal(a.getText(), "hello from A");
  assert.equal(b.getText(), "hello from B");
});

test("a live document rehydrates its own stream after a restart", () => {
  const db = new DatabaseSync(":memory:");
  const first = createLiveDocument(createPersistence(db, "7"));
  first.applyUpdate(updateInserting("persisted"), "agent");
  first.snapshotAndCompact();

  // A fresh instance over the same key + db recovers the content.
  const restored = createLiveDocument(createPersistence(db, "7"));
  assert.equal(restored.getText(), "persisted");
  // A different key over the same db is empty.
  const other = createLiveDocument(createPersistence(db, "8"));
  assert.equal(other.getText(), "");
});

test("cursors are scoped to a single live document", () => {
  const db = new DatabaseSync(":memory:");
  const a = createLiveDocument(createPersistence(db, "1"));
  const b = createLiveDocument(createPersistence(db, "2"));
  a.applyUpdate(updateInserting("0123456789"), "agent-a");

  a.upsertCursor("agent-a", {anchor: 1, head: 3});
  assert.equal(a.getCursors().length, 1);
  assert.equal(b.getCursors().length, 0);
});
