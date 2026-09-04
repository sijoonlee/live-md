import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

// Point the shared db at a throwaway location before importing (db.ts reads DATA_DIR
// at import time).
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "activity-test-"));
const {recordActivity, listActivity, countActivity, MAX_ACTIVITY_PER_DOCUMENT} = await import("../../src/activity.js");
const {createDocument} = await import("../../src/directory.js");

const rootId = 1; // The single Root folder is created with id 1.
const docA = createDocument(rootId, "activity-a.md")!.id;
const docB = createDocument(rootId, "activity-b.md")!.id;

test("recordActivity mints a durable id and listActivity returns the entry", () => {
  const id = recordActivity({documentId: docA, revision: 1, authorLabel: "alice", metadata: {reason: "x"}});
  assert.match(id, /^[0-9a-f-]{36}$/); // uuid
  const list = listActivity(docA);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].revision, 1);
  assert.equal(list[0].authorLabel, "alice");
  assert.deepEqual(list[0].metadata, {reason: "x"});
});

test("activity is scoped per document and ordered newest-first", () => {
  const first = recordActivity({documentId: docB, revision: 1, authorLabel: "a"});
  const second = recordActivity({documentId: docB, revision: 2, authorLabel: "b"});
  const list = listActivity(docB);
  assert.equal(list[0].id, second); // newest first
  assert.equal(list[1].id, first);
  // docA's earlier entry is not mixed in.
  assert.ok(list.every((e) => e.documentId === docB));
});

test("paging with a `before` cursor walks backward", () => {
  const doc = createDocument(rootId, "activity-page.md")!.id;
  const ids = [] as string[];
  for (let i = 1; i <= 5; i += 1) ids.push(recordActivity({documentId: doc, revision: i, authorLabel: "a"}));
  const firstPage = listActivity(doc, {limit: 2});
  assert.deepEqual(firstPage.map((e) => e.revision), [5, 4]);
  const secondPage = listActivity(doc, {limit: 2, before: firstPage[1].id});
  assert.deepEqual(secondPage.map((e) => e.revision), [3, 2]);
  // An unknown cursor yields nothing.
  assert.deepEqual(listActivity(doc, {before: "not-a-real-id"}), []);
});

test("retention prunes to the newest MAX_ACTIVITY_PER_DOCUMENT rows", () => {
  const doc = createDocument(rootId, "activity-prune.md")!.id;
  const total = MAX_ACTIVITY_PER_DOCUMENT + 25;
  let lastId = "";
  for (let i = 1; i <= total; i += 1) lastId = recordActivity({documentId: doc, revision: i, authorLabel: "a"});
  assert.equal(countActivity(doc), MAX_ACTIVITY_PER_DOCUMENT);
  // The most recent entry is retained; the oldest are gone.
  const newest = listActivity(doc, {limit: 1})[0];
  assert.equal(newest.id, lastId);
  assert.equal(newest.revision, total);
});
