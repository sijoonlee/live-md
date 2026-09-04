import * as Y from "yjs";
import type {LiveDocument} from "./document.js";
import {getDocument, listDocuments, listFolders, type DirectoryDocument} from "./directory.js";
import {getLiveDocument} from "./document-registry.js";
import {addRootComment, listComments} from "./comments.js";

// The document operations behind the MCP tools. Kept apart from the transport in
// mcp.ts so the interesting part — resolving a text anchor against the live
// document — is unit-testable without speaking JSON-RPC.
//
// Everything here goes through the same primitives the HTTP routes use, so an
// agent's edit persists, broadcasts to open browsers, and lands in the activity
// log exactly like a human's.

export class ToolError extends Error {}

// --- anchors --------------------------------------------------------------
//
// Agents are poor at character offsets, and an offset computed a second ago may
// already be stale because the human typed above it. So edits name their target by
// content and it is resolved against the *current* text at apply time — an edit
// stays valid however much changed elsewhere in the document.

// Agents routinely send "\r\n" for text stored as "\n" (or the reverse), which
// makes an otherwise-correct anchor mysteriously fail to match. Compare with all
// carriage returns removed, keeping a map back to real offsets so the edit still
// applies at the right place in the untouched document.
const stripCarriageReturns = (value: string): {text: string; offsets: number[]} => {
  if (!value.includes("\r")) return {text: value, offsets: []};
  let text = "";
  const offsets: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\r") continue;
    offsets.push(index);
    text += value[index];
  }
  return {text, offsets};
};

export type AnchorMatch = {start: number; end: number};

// Resolve `anchor` to exactly one span of `text`. Deliberately strict: no trimming,
// no whitespace-insensitive retry, no nearest match. An agent handed a soft match
// will confidently rewrite the wrong paragraph, whereas it recovers correctly from
// a clear error telling it to re-read or add context.
export const resolveAnchor = (text: string, anchor: string): AnchorMatch => {
  if (anchor.length === 0) throw new ToolError("oldString must not be empty");

  const haystack = stripCarriageReturns(text);
  const needle = anchor.includes("\r") ? stripCarriageReturns(anchor).text : anchor;

  const first = haystack.text.indexOf(needle);
  if (first === -1) {
    throw new ToolError(
      "oldString was not found in the document. Re-read the document — it may have changed — and copy the text to replace exactly.",
    );
  }
  const second = haystack.text.indexOf(needle, first + 1);
  if (second !== -1) {
    const count = haystack.text.split(needle).length - 1;
    throw new ToolError(
      `oldString matches ${count} places in the document. Include more surrounding text so it identifies exactly one.`,
    );
  }
  if (haystack.offsets.length === 0) return {start: first, end: first + needle.length};
  // The end is one past the last *matched* character, not the position of the next
  // kept one — otherwise a "\r" sitting just after the match is swallowed into the
  // span and gets replaced along with it.
  return {start: haystack.offsets[first], end: haystack.offsets[first + needle.length - 1] + 1};
};

// --- edits ----------------------------------------------------------------

// A detached copy of the live document. Comments live in the same Y.Doc as the
// text, so both reading and writing them work through the replica rather than
// widening LiveDocument's deliberately narrow surface.
const replicaOf = (live: LiveDocument): Y.Doc => {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, live.encodeState());
  return replica;
};

export type AcceptUpdate = (
  documentId: number,
  live: LiveDocument,
  agentId: string,
  update: Uint8Array,
  metadata?: Record<string, unknown>,
  requestId?: string,
  authorId?: number,
) => number;

// Mutate a replica aligned to the live document's state and feed the resulting
// updates through the normal accept path — the same idiom the Markdown importer
// uses. Editing a replica rather than the live Y.Doc keeps every mutation on one
// route to persistence, broadcast and the activity log.
const commit = (
  documentId: number,
  live: LiveDocument,
  author: string,
  acceptUpdate: AcceptUpdate,
  metadata: Record<string, unknown>,
  mutate: (replica: Y.Doc) => void,
): number => {
  const replica = replicaOf(live);
  const updates: Uint8Array[] = [];
  replica.on("update", (update: Uint8Array) => updates.push(update));
  mutate(replica);
  let revision = live.getRevision();
  for (const update of updates) {
    revision = acceptUpdate(documentId, live, author, update, metadata);
  }
  return revision;
};

// --- documents ------------------------------------------------------------

// Every document is reachable in this build; the only failure is one that does not
// exist. Kept as a helper so the tools all report a missing document the same way.
const requireDocument = (documentId: number) => {
  const meta = getDocument(documentId);
  if (!meta) throw new ToolError(`document ${documentId} not found`);
  return {meta, live: getLiveDocument(documentId)};
};

// Walk the folder tree so each document can be reported with a human-meaningful
// path — an agent asked to "work on my design doc" needs names, not bare ids.
export const allDocuments = (): {document: DirectoryDocument; path: string}[] => {
  const found: {document: DirectoryDocument; path: string}[] = [];
  const walk = (folderId: number, prefix: string) => {
    for (const document of listDocuments(folderId)) found.push({document, path: `${prefix}/${document.name}`});
    for (const child of listFolders(folderId)) walk(child.id, `${prefix}/${child.name}`);
  };
  for (const root of listFolders(null)) walk(root.id, root.name === "Root" ? "" : `/${root.name}`);
  return found;
};

// --- tools ----------------------------------------------------------------

export const listDocumentsTool = () =>
  allDocuments().map(({document, path}) => ({
    documentId: document.id,
    name: document.name,
    path,
    updatedAt: document.updatedAt,
  }));

export const readDocumentTool = (documentId: number) => {
  const {meta, live} = requireDocument(documentId);
  return {
    documentId,
    name: meta.name,
    // The revision doubles as an optimistic-concurrency token: pass it back to
    // edit_document to be told, rather than silently overwrite, when the document
    // moved on in between.
    version: live.getRevision(),
    content: live.getText(),
  };
};

export const editDocumentTool = (
  author: string,
  acceptUpdate: AcceptUpdate,
  args: {documentId: number; oldString: string; newString: string; expectedVersion?: number},
) => {
  const {live} = requireDocument(args.documentId);
  if (args.expectedVersion !== undefined && args.expectedVersion !== live.getRevision()) {
    throw new ToolError(
      `document changed since it was read (expected version ${args.expectedVersion}, now ${live.getRevision()}). Re-read it and retry.`,
    );
  }
  const {start, end} = resolveAnchor(live.getText(), args.oldString);
  const version = commit(args.documentId, live, author, acceptUpdate, {reason: "mcp:edit_document"}, (replica) => {
    const content = replica.getText("content");
    content.delete(start, end - start);
    if (args.newString.length > 0) content.insert(start, args.newString);
  });
  return {documentId: args.documentId, version, replacedAt: start};
};

export const appendDocumentTool = (
  author: string,
  acceptUpdate: AcceptUpdate,
  args: {documentId: number; content: string},
) => {
  const {live} = requireDocument(args.documentId);
  if (args.content.length === 0) throw new ToolError("content must not be empty");
  const version = commit(args.documentId, live, author, acceptUpdate, {reason: "mcp:append_document"}, (replica) => {
    const content = replica.getText("content");
    content.insert(content.length, args.content);
  });
  return {documentId: args.documentId, version};
};

export const addCommentTool = (
  author: string,
  acceptUpdate: AcceptUpdate,
  args: {documentId: number; anchorText: string; body: string},
) => {
  const {live} = requireDocument(args.documentId);
  if (args.body.trim().length === 0) throw new ToolError("body must not be empty");
  // Anchor on text, not a line number: the comment then lands on the passage the
  // agent means even though it never saw line numbers.
  const {start} = resolveAnchor(live.getText(), args.anchorText);
  let commentId = "";
  commit(args.documentId, live, author, acceptUpdate, {reason: "mcp:add_comment"}, (replica) => {
    commentId = addRootComment(replica, {charIndex: start, author, body: args.body});
  });
  return {commentId, documentId: args.documentId};
};

export const listCommentsTool = (documentId: number) => {
  const {live} = requireDocument(documentId);
  return listComments(replicaOf(live)).map((comment) => ({
    commentId: comment.id,
    parentId: comment.parentId,
    line: comment.line,
    author: comment.author,
    body: comment.body,
    resolved: comment.resolved,
  }));
};
