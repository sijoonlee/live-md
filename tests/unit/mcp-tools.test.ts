import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-tools-test-"));

const {
  ToolError,
  resolveAnchor,
  addCommentTool,
  appendDocumentTool,
  editDocumentTool,
  listCommentsTool,
  listDocumentsTool,
  readDocumentTool,
  attachFileTool,
  listAttachmentsTool,
  deleteAttachmentTool,
  exportDocumentTool,
  importDocumentTool,
  replyToCommentTool,
  resolveCommentTool,
  deleteCommentTool,
} = await import("../../src/mcp-tools.js");
const {createDocument, createFolder, listFolders} = await import("../../src/directory.js");
const {getLiveDocument} = await import("../../src/document-registry.js");

// A stand-in for the server's accept path: applies the update to the live document
// exactly as acceptUpdate does, without the activity log or the WebSocket fan-out.
const accepted: {documentId: number; agentId: string; metadata?: Record<string, unknown>}[] = [];
const AUTHOR = "local";
const acceptUpdate = (
  documentId: number,
  live: ReturnType<typeof getLiveDocument>,
  agentId: string,
  update: Uint8Array,
  metadata?: Record<string, unknown>,
) => {
  accepted.push({documentId, agentId, metadata});
  return live.applyUpdate(update, agentId, metadata);
};

const rootFolder = listFolders(null)[0];
// Seed content through the tools themselves, so the fixtures exercise the same
// path an agent takes.
const seeded = (name: string, content: string) => {
  const meta = createDocument(rootFolder.id, name);
  if (content) appendDocumentTool(AUTHOR, acceptUpdate, {documentId: meta.id, content});
  return meta;
};

// --- anchor resolution ----------------------------------------------------

test("resolveAnchor finds a unique passage", () => {
  const text = "# Title\n\nAlpha paragraph.\n\nBeta paragraph.\n";
  const {start, end} = resolveAnchor(text, "Beta paragraph.");
  assert.equal(text.slice(start, end), "Beta paragraph.");
});

test("resolveAnchor refuses a passage that is not there, and says what to do", () => {
  assert.throws(
    () => resolveAnchor("hello world", "goodbye"),
    (error: Error) => error instanceof ToolError && /Re-read the document/.test(error.message),
  );
});

test("resolveAnchor refuses an ambiguous passage rather than guessing", () => {
  assert.throws(
    () => resolveAnchor("todo\nsomething\ntodo\n", "todo"),
    (error: Error) => error instanceof ToolError && /matches 2 places/.test(error.message),
  );
});

test("resolveAnchor rejects an empty anchor", () => {
  assert.throws(() => resolveAnchor("anything", ""), ToolError);
});

// Agents routinely send CRLF for text stored as LF. Matching must survive that, and
// the returned offsets must still address the untouched document.
test("resolveAnchor matches across CRLF/LF differences, both directions", () => {
  const lf = "one\ntwo\nthree\n";
  const viaCrlf = resolveAnchor(lf, "one\r\ntwo");
  assert.equal(lf.slice(viaCrlf.start, viaCrlf.end), "one\ntwo");

  const crlf = "one\r\ntwo\r\nthree\r\n";
  const viaLf = resolveAnchor(crlf, "two\nthree");
  assert.equal(crlf.slice(viaLf.start, viaLf.end), "two\r\nthree");
});

// --- edits ----------------------------------------------------------------

test("edit_document replaces the anchored passage and bumps the version", () => {
  const meta = seeded("edit-target", "# Spec\n\nOld sentence.\n");
  const before = readDocumentTool(meta.id);
  const result = editDocumentTool(AUTHOR, acceptUpdate, {
    documentId: meta.id,
    oldString: "Old sentence.",
    newString: "New sentence, much improved.",
  });
  assert.equal(readDocumentTool(meta.id).content, "# Spec\n\nNew sentence, much improved.\n");
  assert.ok(result.version > before.version);
});

test("edit_document with an empty newString deletes the passage", () => {
  const meta = seeded("delete-target", "keep\nDROP THIS\nkeep too\n");
  editDocumentTool(AUTHOR, acceptUpdate, {documentId: meta.id, oldString: "DROP THIS\n", newString: ""});
  assert.equal(readDocumentTool(meta.id).content, "keep\nkeep too\n");
});

// The point of anchoring: an agent's edit stays valid even though the document
// changed underneath it, as long as the passage it named is still there.
test("an edit still lands after someone else edits elsewhere in the document", () => {
  const meta = seeded("concurrent", "## Intro\n\nIntro text.\n\n## Details\n\nDetail text.\n");
  editDocumentTool(AUTHOR, acceptUpdate, {
    documentId: meta.id,
    oldString: "Intro text.",
    newString: "Intro text, expanded by a person while the agent was thinking.",
  });
  // The agent resolved this anchor against the older content; it must still apply.
  editDocumentTool(AUTHOR, acceptUpdate, {
    documentId: meta.id,
    oldString: "Detail text.",
    newString: "Detail text written by the agent.",
  });
  const {content} = readDocumentTool(meta.id);
  assert.match(content, /expanded by a person/);
  assert.match(content, /written by the agent/);
});

test("expectedVersion refuses an edit against a document that has moved on", () => {
  const meta = seeded("stale", "content here\n");
  const stale = readDocumentTool(meta.id).version;
  appendDocumentTool(AUTHOR, acceptUpdate, {documentId: meta.id, content: "a later change\n"});
  assert.throws(
    () =>
      editDocumentTool(AUTHOR, acceptUpdate, {
        documentId: meta.id,
        oldString: "content here",
        newString: "clobbered",
        expectedVersion: stale,
      }),
    (error: Error) => error instanceof ToolError && /changed since it was read/.test(error.message),
  );
});

test("append_document adds to the end", () => {
  const meta = seeded("appendable", "first\n");
  appendDocumentTool(AUTHOR, acceptUpdate, {documentId: meta.id, content: "second\n"});
  assert.equal(readDocumentTool(meta.id).content, "first\nsecond\n");
});

test("edits are attributed to the calling agent", () => {
  const meta = seeded("attributed", "text to change\n");
  accepted.length = 0;
  editDocumentTool("mcp-attribution-bot", acceptUpdate, {documentId: meta.id, oldString: "change", newString: "keep"});
  assert.equal(accepted.at(-1)?.agentId, "mcp-attribution-bot");
  assert.equal(accepted.at(-1)?.metadata?.reason, "mcp:edit_document");
});

// --- comments -------------------------------------------------------------

test("add_comment anchors a comment to a passage without editing it", () => {
  const meta = seeded("commentable", "# Doc\n\nA claim needing a source.\n");
  const {commentId} = addCommentTool(AUTHOR, acceptUpdate, {
    documentId: meta.id,
    anchorText: "A claim needing a source.",
    body: "Where is this from?",
  });
  assert.ok(commentId);
  assert.equal(readDocumentTool(meta.id).content, "# Doc\n\nA claim needing a source.\n", "text is untouched");

  const comments = listCommentsTool(meta.id);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, "Where is this from?");
  assert.equal(comments[0].author, AUTHOR);
  assert.equal(comments[0].line, 3, "the comment lands on the commented line");
});

test("add_comment refuses an ambiguous anchor", () => {
  const meta = seeded("ambiguous-comment", "same\nsame\n");
  assert.throws(
    () => addCommentTool(AUTHOR, acceptUpdate, {documentId: meta.id, anchorText: "same", body: "which one?"}),
    ToolError,
  );
});

test("list_documents reports folder paths so an agent can find a document by name", () => {
  const folder = createFolder("Specs", rootFolder.id);
  const meta = createDocument(folder.id, "auth-design");
  const entry = listDocumentsTool().find((item) => item.documentId === meta.id);
  assert.equal(entry?.path, "/Specs/auth-design");
});


// --- attachments ----------------------------------------------------------

test("attach_file stores a local file and returns Markdown ready to insert", () => {
  const meta = seeded("attachable", "# Doc\n");
  const source = path.join(process.env.DATA_DIR!, "upload.txt");
  writeFileSync(source, "some bytes");

  const attached = attachFileTool(AUTHOR, {documentId: meta.id, path: source});
  assert.equal(attached.filename, "upload.txt");
  assert.equal(attached.bytes, 10);
  // Attaching does not touch the text; the agent inserts the link itself.
  assert.equal(readDocumentTool(meta.id).content, "# Doc\n");
  assert.match(attached.markdown, /^\[upload\.txt\]\(\/api\/files\/\d+\)$/);

  const listed = listAttachmentsTool(meta.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].fileId, attached.fileId);
});

test("attach_file reports a path it cannot read rather than failing silently", () => {
  const meta = seeded("bad-path", "# Doc\n");
  assert.throws(
    () => attachFileTool(AUTHOR, {documentId: meta.id, path: "/definitely/not/here.txt"}),
    (error: Error) => error instanceof ToolError && /could not read/.test(error.message),
  );
});

test("delete_attachment removes the file and refuses an unknown id", () => {
  const meta = seeded("deletable-attachment", "# Doc\n");
  const source = path.join(process.env.DATA_DIR!, "gone.txt");
  writeFileSync(source, "bytes");
  const {fileId} = attachFileTool(AUTHOR, {documentId: meta.id, path: source});

  assert.equal(deleteAttachmentTool(fileId).deleted, true);
  assert.equal(listAttachmentsTool(meta.id).length, 0);
  assert.throws(() => deleteAttachmentTool(fileId), ToolError);
});

// --- import / export ------------------------------------------------------

test("export_document writes Markdown, and a directory target uses the document's name", () => {
  const meta = seeded("exportable.md", "# Exportable\n\nbody\n");
  const dir = process.env.DATA_DIR!;
  const result = exportDocumentTool({documentId: meta.id, path: dir});
  assert.equal(path.basename(result.path), "exportable.md");
  assert.equal(readFileSync(result.path, "utf8"), "# Exportable\n\nbody\n");
});

// The point of the bundle: a document and its attachments survive a round trip
// through the filesystem, with links repointed at the newly stored files.
test("a document with an attachment round-trips through export and import", () => {
  const meta = seeded("bundled", "# Bundled\n\nsee the file\n");
  const source = path.join(process.env.DATA_DIR!, "table.csv");
  writeFileSync(source, "a,b\n1,2\n");
  const {markdown, fileId} = attachFileTool(AUTHOR, {documentId: meta.id, path: source});
  editDocumentTool(AUTHOR, acceptUpdate, {
    documentId: meta.id,
    oldString: "see the file",
    newString: `see the file: ${markdown}`,
  });

  const zipPath = path.join(process.env.DATA_DIR!, "bundle.zip");
  const exported = exportDocumentTool({documentId: meta.id, path: zipPath});
  assert.equal(exported.path, zipPath);

  const imported = importDocumentTool(AUTHOR, acceptUpdate, {path: zipPath, name: "restored.md"});
  assert.equal(imported.attachments, 1);

  const restored = readDocumentTool(imported.documentId);
  assert.match(restored.content, /# Bundled/);
  // The link points at the NEW attachment, not the original one.
  const restoredFileId = listAttachmentsTool(imported.documentId)[0].fileId;
  assert.notEqual(restoredFileId, fileId);
  assert.match(restored.content, new RegExp(`/api/files/${restoredFileId}\\)`));
});

test("import_document reports an unreadable path and an invalid bundle", () => {
  assert.throws(
    () => importDocumentTool(AUTHOR, acceptUpdate, {path: "/definitely/not/here.md"}),
    (error: Error) => error instanceof ToolError && /could not read/.test(error.message),
  );
  const notAZip = path.join(process.env.DATA_DIR!, "broken.zip");
  writeFileSync(notAZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  assert.throws(() => importDocumentTool(AUTHOR, acceptUpdate, {path: notAZip}), ToolError);
});

// --- comment threads ------------------------------------------------------

test("reply_to_comment, resolve_comment and delete_comment work a thread", () => {
  const meta = seeded("threaded", "# Doc\n\nA claim.\n");
  const {commentId} = addCommentTool(AUTHOR, acceptUpdate, {
    documentId: meta.id,
    anchorText: "A claim.",
    body: "Source?",
  });

  const reply = replyToCommentTool("agent", acceptUpdate, {documentId: meta.id, commentId, body: "Added one."});
  assert.equal(reply.parentId, commentId);
  const withReply = listCommentsTool(meta.id);
  assert.equal(withReply.length, 2);
  assert.equal(withReply.find((c) => c.commentId === reply.commentId)?.author, "agent");

  assert.equal(resolveCommentTool(AUTHOR, acceptUpdate, {documentId: meta.id, commentId}).resolved, true);
  assert.equal(listCommentsTool(meta.id).find((c) => c.commentId === commentId)?.resolved, true);
  // Reopening is the same tool with resolved: false.
  resolveCommentTool(AUTHOR, acceptUpdate, {documentId: meta.id, commentId, resolved: false});
  assert.equal(listCommentsTool(meta.id).find((c) => c.commentId === commentId)?.resolved, false);

  // A root with replies is tombstoned so the conversation stays readable.
  deleteCommentTool(AUTHOR, acceptUpdate, {documentId: meta.id, commentId});
  assert.equal(listCommentsTool(meta.id).find((c) => c.commentId === commentId)?.body, "[deleted]");
});

test("comment tools refuse an unknown id and refuse to resolve a reply", () => {
  const meta = seeded("thread-errors", "# Doc\n\nAnchor here.\n");
  const {commentId} = addCommentTool(AUTHOR, acceptUpdate, {
    documentId: meta.id,
    anchorText: "Anchor here.",
    body: "root",
  });
  const reply = replyToCommentTool(AUTHOR, acceptUpdate, {documentId: meta.id, commentId, body: "reply"});

  assert.throws(
    () => replyToCommentTool(AUTHOR, acceptUpdate, {documentId: meta.id, commentId: "nope", body: "x"}),
    (error: Error) => error instanceof ToolError && /list_comments/.test(error.message),
  );
  assert.throws(
    () => resolveCommentTool(AUTHOR, acceptUpdate, {documentId: meta.id, commentId: reply.commentId}),
    (error: Error) => error instanceof ToolError && /first comment/.test(error.message),
  );
});
