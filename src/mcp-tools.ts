import * as Y from "yjs";
import type {LiveDocument} from "./document.js";
import {getDocument, listDocuments, type DirectoryDocument} from "./directory.js";
import {getLiveDocument} from "./document-registry.js";
import {addReply, addRootComment, deleteComment as removeComment, listComments, setResolved} from "./comments.js";
import {readFileSync, statSync, writeFileSync} from "node:fs";
import {basename, join} from "node:path";
import {deleteFile, getFileMetadata, listFiles, saveFile} from "./files.js";
import {buildExport, guessMimeType, importBundle} from "./export-import.js";
import {listFolders} from "./directory.js";

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
const rootFolderId = () => listFolders(null)[0].id;

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

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

// --- attachments ----------------------------------------------------------
//
// Files move by path rather than as base64 in a tool argument: the agent and the
// server share a filesystem in this build, and routing megabytes through a model's
// context to move a file it can already see would be absurd.

export const listAttachmentsTool = (documentId: number) => {
  requireDocument(documentId);
  return listFiles(documentId).map((file) => ({
    fileId: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    bytes: file.size,
    isImage: file.isImage,
    // What to put in the Markdown to reference it.
    reference: file.url,
  }));
};

export const attachFileTool = (author: string, args: {documentId: number; path: string; filename?: string}) => {
  requireDocument(args.documentId);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(args.path));
  } catch {
    throw new ToolError(`could not read ${args.path}`);
  }
  const filename = args.filename?.trim() || basename(args.path);
  try {
    const file = saveFile(bytes, guessMimeType(filename), args.documentId, {filename, uploadedBy: author});
    return {
      fileId: file.id,
      filename: file.filename,
      bytes: file.size,
      // Ready to paste into the document; images render inline, everything else downloads.
      markdown: `${file.isImage ? "!" : ""}[${file.filename}](${file.url})`,
    };
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : "file could not be stored");
  }
};

export const deleteAttachmentTool = (fileId: number) => {
  const file = getFileMetadata(fileId);
  if (!file) throw new ToolError(`attachment ${fileId} not found`);
  deleteFile(fileId);
  return {fileId, filename: file.filename, deleted: true};
};

// --- import / export ------------------------------------------------------

export const exportDocumentTool = (args: {documentId: number; path: string; format?: "md"}) => {
  requireDocument(args.documentId);
  const result = buildExport(args.documentId, {format: args.format});
  // A directory means "put it here under its own name"; anything else is the file.
  const target = isDirectory(args.path) ? join(args.path, result.filename) : args.path;
  try {
    writeFileSync(target, result.bytes);
  } catch (error) {
    throw new ToolError(`could not write ${target}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return {path: target, bytes: result.bytes.length, warnings: result.warnings};
};

export const importDocumentTool = (
  author: string,
  acceptUpdate: AcceptUpdate,
  args: {path: string; folderId?: number; name?: string},
) => {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(args.path));
  } catch {
    throw new ToolError(`could not read ${args.path}`);
  }
  const folderId = args.folderId ?? rootFolderId();
  try {
    const {document, attachments} = importBundle(folderId, bytes, {
      filename: args.name?.trim() || basename(args.path),
      author,
      accept: (documentId, live, who, update, metadata) => acceptUpdate(documentId, live, who, update, metadata),
    });
    return {documentId: document.id, name: document.name, attachments};
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : "import failed");
  }
};

// --- comment threads ------------------------------------------------------

const findComment = (live: LiveDocument, commentId: string) => {
  const found = listComments(replicaOf(live)).find((comment) => comment.id === commentId);
  if (!found) throw new ToolError(`comment ${commentId} not found; call list_comments for current ids`);
  return found;
};

export const replyToCommentTool = (
  author: string,
  acceptUpdate: AcceptUpdate,
  args: {documentId: number; commentId: string; body: string},
) => {
  const {live} = requireDocument(args.documentId);
  if (args.body.trim().length === 0) throw new ToolError("body must not be empty");
  findComment(live, args.commentId);
  let replyId = "";
  commit(args.documentId, live, author, acceptUpdate, {reason: "mcp:reply_to_comment"}, (replica) => {
    replyId = addReply(replica, {parentId: args.commentId, author, body: args.body});
  });
  return {commentId: replyId, parentId: args.commentId};
};

export const resolveCommentTool = (
  author: string,
  acceptUpdate: AcceptUpdate,
  args: {documentId: number; commentId: string; resolved?: boolean},
) => {
  const {live} = requireDocument(args.documentId);
  const comment = findComment(live, args.commentId);
  if (comment.parentId !== null) throw new ToolError("only a thread's first comment can be resolved");
  const resolved = args.resolved ?? true;
  commit(args.documentId, live, author, acceptUpdate, {reason: "mcp:resolve_comment"}, (replica) => {
    setResolved(replica, args.commentId, resolved);
  });
  return {commentId: args.commentId, resolved};
};

export const deleteCommentTool = (
  author: string,
  acceptUpdate: AcceptUpdate,
  args: {documentId: number; commentId: string},
) => {
  const {live} = requireDocument(args.documentId);
  findComment(live, args.commentId);
  commit(args.documentId, live, author, acceptUpdate, {reason: "mcp:delete_comment"}, (replica) => {
    removeComment(replica, args.commentId);
  });
  return {commentId: args.commentId, deleted: true};
};
