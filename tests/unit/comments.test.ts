import assert from "node:assert/strict";
import {test} from "node:test";
import * as Y from "yjs";
import {
  addReply,
  addRootComment,
  commentsType,
  deleteComment,
  encodeLineAnchor,
  listComments,
  resolveAnchorLine,
  setResolved,
  updateCommentBody,
} from "../../src/comments.js";

const docWith = (value: string) => {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return doc;
};

// charIndex of the first character of a 1-based line number.
const lineStart = (text: string, line: number) => {
  let index = 0;
  for (let n = 1; n < line; n += 1) index = text.indexOf("\n", index) + 1;
  return index;
};

test("a root comment resolves to the line it was anchored on", () => {
  const text = "line one\nline two\nline three";
  const doc = docWith(text);
  addRootComment(doc, {charIndex: lineStart(text, 2) + 3, authorId: 1, body: "hi"});
  assert.equal(listComments(doc)[0].line, 2);
});

test("inserting lines above pushes the comment down", () => {
  const text = "alpha\nbeta\ngamma";
  const doc = docWith(text);
  addRootComment(doc, {charIndex: lineStart(text, 3), authorId: 1, body: "on gamma"});
  assert.equal(listComments(doc)[0].line, 3);

  // Insert two new lines at the very top; the anchored line moves to 5.
  doc.getText("content").insert(0, "new1\nnew2\n");
  assert.equal(listComments(doc)[0].line, 5);
});

test("inserting below the anchor does not move the comment", () => {
  const text = "alpha\nbeta\ngamma";
  const doc = docWith(text);
  addRootComment(doc, {charIndex: lineStart(text, 1), authorId: 1, body: "on alpha"});

  doc.getText("content").insert(text.length, "\ndelta\nepsilon");
  assert.equal(listComments(doc)[0].line, 1);
});

test("deleting the anchored line's first letter keeps it on the same line", () => {
  const text = "alpha\nbeta\ngamma";
  const doc = docWith(text);
  const start = lineStart(text, 2);
  addRootComment(doc, {charIndex: start, authorId: 1, body: "on beta"});

  // Remove the "b" of "beta" (tombstone) — relative position still resolves.
  doc.getText("content").delete(start, 1);
  assert.equal(listComments(doc)[0].line, 2);
});

test("deleting the whole line's text keeps it on the now-empty line", () => {
  const text = "alpha\nbeta\ngamma";
  const doc = docWith(text);
  const start = lineStart(text, 2);
  addRootComment(doc, {charIndex: start, authorId: 1, body: "on beta"});

  doc.getText("content").delete(start, "beta".length); // "alpha\n\ngamma"
  assert.equal(doc.getText("content").toString(), "alpha\n\ngamma");
  assert.equal(listComments(doc)[0].line, 2);
});

test("an anchor whose content the doc never received resolves to null (detached)", () => {
  // The `null` branch: an anchor bound to a character identity the target doc has
  // never seen (never-synced content). Simple letter/line deletion is NOT this case
  // — tombstones keep it resolvable — so we exercise it with an unshared doc.
  const source = docWith("keep\ntarget line\nkeep");
  const anchor = encodeLineAnchor(source, lineStart("keep\ntarget line\nkeep", 2));

  const stranger = docWith("unrelated content");
  assert.equal(resolveAnchorLine(stranger, anchor), null);
});

test("replies carry no anchor and thread under their parent", () => {
  const doc = docWith("only line");
  const rootId = addRootComment(doc, {charIndex: 0, authorId: 1, body: "root"});
  const replyId = addReply(doc, {parentId: rootId, authorId: 2, body: "reply"});

  const list = listComments(doc);
  const reply = list.find((c) => c.id === replyId)!;
  assert.equal(reply.parentId, rootId);
  assert.equal(reply.anchor, null);
  assert.equal(reply.line, null);
});

test("resolve is a root-only, whole-thread flag", () => {
  const doc = docWith("only line");
  const rootId = addRootComment(doc, {charIndex: 0, authorId: 1, body: "root"});
  const replyId = addReply(doc, {parentId: rootId, authorId: 2, body: "reply"});

  setResolved(doc, rootId, true);
  setResolved(doc, replyId, true); // no-op on a reply
  const list = listComments(doc);
  assert.equal(list.find((c) => c.id === rootId)!.resolved, true);
  assert.equal(list.find((c) => c.id === replyId)!.resolved, undefined);
});

test("deleting a root with replies tombstones it; a leaf is removed", () => {
  const doc = docWith("only line");
  const rootId = addRootComment(doc, {charIndex: 0, authorId: 1, body: "root"});
  const replyId = addReply(doc, {parentId: rootId, authorId: 2, body: "reply"});

  deleteComment(doc, rootId); // has a reply → tombstone
  assert.equal(listComments(doc).find((c) => c.id === rootId)!.body, "[deleted]");
  assert.equal(commentsType(doc).length, 2);

  deleteComment(doc, replyId); // leaf → removed
  assert.equal(commentsType(doc).length, 1);
});

test("updateCommentBody edits in place", () => {
  const doc = docWith("only line");
  const id = addRootComment(doc, {charIndex: 0, authorId: 1, body: "before"});
  updateCommentBody(doc, id, "after");
  assert.equal(listComments(doc)[0].body, "after");
});

test("comments ride the Y.Doc: they sync via state updates", () => {
  const a = docWith("shared line");
  const id = addRootComment(a, {charIndex: 0, authorId: 1, body: "hello"});

  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const onB = listComments(b);
  assert.equal(onB.length, 1);
  assert.equal(onB[0].id, id);
  assert.equal(onB[0].body, "hello");
  assert.equal(onB[0].line, 1);
});
