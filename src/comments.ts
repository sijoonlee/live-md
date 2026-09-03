import * as Y from "yjs";

// Comments for a document live in a sibling shared type alongside the "content"
// Y.Text, so they ride the same sync + persistence as the text (see M8 plan). A
// comment is anchored to a LINE, not to characters on it: the anchor is a Yjs
// relative position at the line's start, so inserting lines above pushes the
// comment down while editing/deleting the line's own text leaves it in place.
//
// This module is pure Yjs (no server, no UI). Every mutation is an ordinary Y.Doc
// change, so it flows over the existing WebSocket sync and persistence untouched.

const COMMENTS_KEY = "comments";
const CONTENT_KEY = "content";

export type CommentRecord = {
  id: string;
  parentId: string | null; // null = root (carries an anchor); set = reply (no anchor)
  anchor: string | null; // base64 Y.encodeRelativePosition — only on roots
  authorId: number;
  body: string;
  createdAt: string;
  resolved?: boolean; // roots only — a thread resolves as a whole
};

// A comment plus its resolved 1-based line (roots only). `line` is null when a root's
// anchor no longer resolves (detached) or for replies (which have no anchor).
export type ResolvedComment = CommentRecord & {line: number | null};

// Base64 helpers that work in both Node (AgentClient) and the browser bundle, since
// this module is imported by both. Prefer Buffer where present; fall back to atob/btoa.
const toBase64 = (bytes: Uint8Array) =>
  typeof Buffer !== "undefined"
    ? Buffer.from(bytes).toString("base64")
    : btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) =>
  typeof Buffer !== "undefined"
    ? new Uint8Array(Buffer.from(value, "base64"))
    : Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export const commentsType = (doc: Y.Doc) => doc.getArray<Y.Map<unknown>>(COMMENTS_KEY);
const contentType = (doc: Y.Doc) => doc.getText(CONTENT_KEY);

// Encode a line anchor: a relative position at the START of the line containing
// `charIndex`. assoc=1 biases the anchor toward the line's first content character,
// so typing at the very start of the line keeps the comment on that line.
export const encodeLineAnchor = (doc: Y.Doc, charIndex: number): string => {
  const text = contentType(doc);
  const s = text.toString();
  const from = Math.max(0, Math.min(charIndex, s.length));
  const lineStart = s.lastIndexOf("\n", from - 1) + 1;
  const rel = Y.createRelativePositionFromTypeIndex(text, lineStart, 1);
  return toBase64(Y.encodeRelativePosition(rel));
};

// Resolve an encoded anchor to a current absolute index into the content text, or
// null when it can no longer be resolved (anchored content deleted AND GC'd, or an
// anchor from a never-synced doc). Simple letter/line deletion is NOT null: Yjs
// tombstones keep the relative position resolvable.
export const resolveAnchorIndex = (doc: Y.Doc, encoded: string): number | null => {
  const rel = Y.decodeRelativePosition(fromBase64(encoded));
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  return abs ? abs.index : null;
};

// Resolve an encoded anchor to a 1-based line number, or null if detached. Counting
// newlines here keeps the module free of any editor/line model.
export const resolveAnchorLine = (doc: Y.Doc, encoded: string): number | null => {
  const index = resolveAnchorIndex(doc, encoded);
  if (index === null) return null;
  const s = contentType(doc).toString();
  const clamped = Math.min(index, s.length);
  let line = 1;
  for (let i = 0; i < clamped; i += 1) if (s[i] === "\n") line += 1;
  return line;
};

const readComment = (map: Y.Map<unknown>): CommentRecord => ({
  id: map.get("id") as string,
  parentId: (map.get("parentId") as string | null) ?? null,
  anchor: (map.get("anchor") as string | null) ?? null,
  authorId: map.get("authorId") as number,
  body: map.get("body") as string,
  createdAt: map.get("createdAt") as string,
  resolved: (map.get("resolved") as boolean | undefined) ?? undefined,
});

const findMap = (doc: Y.Doc, id: string): Y.Map<unknown> | undefined => {
  for (const map of commentsType(doc)) {
    if (map.get("id") === id) return map;
  }
  return undefined;
};

const hasReplies = (doc: Y.Doc, id: string): boolean => {
  for (const map of commentsType(doc)) {
    if (map.get("parentId") === id) return true;
  }
  return false;
};

// Add a root comment anchored to the line containing `charIndex`. Returns the new id.
export const addRootComment = (
  doc: Y.Doc,
  {charIndex, authorId, body}: {charIndex: number; authorId: number; body: string},
): string => {
  const id = crypto.randomUUID();
  const map = new Y.Map<unknown>();
  map.set("id", id);
  map.set("parentId", null);
  map.set("anchor", encodeLineAnchor(doc, charIndex));
  map.set("authorId", authorId);
  map.set("body", body);
  map.set("createdAt", new Date().toISOString());
  map.set("resolved", false);
  commentsType(doc).push([map]);
  return id;
};

// Add a reply to any existing comment (root or another reply). Replies carry no
// anchor — their position is their parent, referenced by the stable parent id.
export const addReply = (
  doc: Y.Doc,
  {parentId, authorId, body}: {parentId: string; authorId: number; body: string},
): string => {
  const id = crypto.randomUUID();
  const map = new Y.Map<unknown>();
  map.set("id", id);
  map.set("parentId", parentId);
  map.set("anchor", null);
  map.set("authorId", authorId);
  map.set("body", body);
  map.set("createdAt", new Date().toISOString());
  commentsType(doc).push([map]);
  return id;
};

export const updateCommentBody = (doc: Y.Doc, id: string, body: string): void => {
  findMap(doc, id)?.set("body", body);
};

// Resolve/unresolve a thread. Only roots carry `resolved`; a no-op on replies.
export const setResolved = (doc: Y.Doc, id: string, resolved = true): void => {
  const map = findMap(doc, id);
  if (map && map.get("parentId") === null) map.set("resolved", resolved);
};

// Delete a comment. A root that still has replies is tombstoned (body → "[deleted]")
// so the thread stays readable; a leaf is removed outright.
export const deleteComment = (doc: Y.Doc, id: string): void => {
  const arr = commentsType(doc);
  const index = arr.toArray().findIndex((m) => m.get("id") === id);
  if (index < 0) return;
  const map = arr.get(index);
  if (map.get("parentId") === null && hasReplies(doc, id)) {
    map.set("body", "[deleted]");
    return;
  }
  arr.delete(index, 1);
};

// All comments with each root's anchor resolved to a line number (null = detached or
// a reply). Ordered as stored; callers group by parentId and sort by createdAt.
export const listComments = (doc: Y.Doc): ResolvedComment[] =>
  commentsType(doc)
    .toArray()
    .map((map) => {
      const record = readComment(map);
      const line = record.anchor ? resolveAnchorLine(doc, record.anchor) : null;
      return {...record, line};
    });
