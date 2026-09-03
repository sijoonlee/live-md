import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync} from "node:fs";
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
} = await import("../../src/mcp-tools.js");
const {createAgentPrincipal} = await import("../../src/auth.js");
const {upsertHumanPrincipal} = await import("../../src/human-auth.js");
const {createDocument, createFolder, listFolders, setShare} = await import("../../src/directory.js");
const {getLiveDocument} = await import("../../src/document-registry.js");
const {setPrincipalRole} = await import("../../src/auth.js");

// A stand-in for the server's accept path: applies the update to the live document
// exactly as acceptUpdate does, without the activity log or the WebSocket fan-out.
const accepted: {documentId: number; agentId: string; metadata?: Record<string, unknown>}[] = [];
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

const owner = upsertHumanPrincipal("test", "owner", undefined, "owner");
const rootFolder = listFolders(null)[0];
// Seed content through the tools themselves, so the fixtures exercise the same
// path an agent takes.
const seeded = (name: string, content: string) => {
  const meta = createDocument(rootFolder.id, name, owner.id);
  if (content) appendDocumentTool(owner, acceptUpdate, {documentId: meta.id, content});
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
  const before = readDocumentTool(owner, meta.id);
  const result = editDocumentTool(owner, acceptUpdate, {
    documentId: meta.id,
    oldString: "Old sentence.",
    newString: "New sentence, much improved.",
  });
  assert.equal(readDocumentTool(owner, meta.id).content, "# Spec\n\nNew sentence, much improved.\n");
  assert.ok(result.version > before.version);
});

test("edit_document with an empty newString deletes the passage", () => {
  const meta = seeded("delete-target", "keep\nDROP THIS\nkeep too\n");
  editDocumentTool(owner, acceptUpdate, {documentId: meta.id, oldString: "DROP THIS\n", newString: ""});
  assert.equal(readDocumentTool(owner, meta.id).content, "keep\nkeep too\n");
});

// The point of anchoring: an agent's edit stays valid even though the document
// changed underneath it, as long as the passage it named is still there.
test("an edit still lands after someone else edits elsewhere in the document", () => {
  const meta = seeded("concurrent", "## Intro\n\nIntro text.\n\n## Details\n\nDetail text.\n");
  editDocumentTool(owner, acceptUpdate, {
    documentId: meta.id,
    oldString: "Intro text.",
    newString: "Intro text, expanded by a person while the agent was thinking.",
  });
  // The agent resolved this anchor against the older content; it must still apply.
  editDocumentTool(owner, acceptUpdate, {
    documentId: meta.id,
    oldString: "Detail text.",
    newString: "Detail text written by the agent.",
  });
  const {content} = readDocumentTool(owner, meta.id);
  assert.match(content, /expanded by a person/);
  assert.match(content, /written by the agent/);
});

test("expectedVersion refuses an edit against a document that has moved on", () => {
  const meta = seeded("stale", "content here\n");
  const stale = readDocumentTool(owner, meta.id).version;
  appendDocumentTool(owner, acceptUpdate, {documentId: meta.id, content: "a later change\n"});
  assert.throws(
    () =>
      editDocumentTool(owner, acceptUpdate, {
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
  appendDocumentTool(owner, acceptUpdate, {documentId: meta.id, content: "second\n"});
  assert.equal(readDocumentTool(owner, meta.id).content, "first\nsecond\n");
});

test("edits are attributed to the calling principal", () => {
  const agent = createAgentPrincipal("mcp-attribution-bot");
  const meta = seeded("attributed", "text to change\n");
  setShare(meta.id, agent.id, "editor");
  accepted.length = 0;
  editDocumentTool(agent, acceptUpdate, {documentId: meta.id, oldString: "change", newString: "keep"});
  assert.equal(accepted.at(-1)?.agentId, "mcp-attribution-bot");
  assert.equal(accepted.at(-1)?.metadata?.reason, "mcp:edit_document");
});

// --- comments -------------------------------------------------------------

test("add_comment anchors a comment to a passage without editing it", () => {
  const meta = seeded("commentable", "# Doc\n\nA claim needing a source.\n");
  const {commentId} = addCommentTool(owner, acceptUpdate, {
    documentId: meta.id,
    anchorText: "A claim needing a source.",
    body: "Where is this from?",
  });
  assert.ok(commentId);
  assert.equal(readDocumentTool(owner, meta.id).content, "# Doc\n\nA claim needing a source.\n", "text is untouched");

  const comments = listCommentsTool(owner, meta.id);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, "Where is this from?");
  assert.equal(comments[0].authorId, owner.id);
  assert.equal(comments[0].line, 3, "the comment lands on the commented line");
});

test("add_comment refuses an ambiguous anchor", () => {
  const meta = seeded("ambiguous-comment", "same\nsame\n");
  assert.throws(
    () => addCommentTool(owner, acceptUpdate, {documentId: meta.id, anchorText: "same", body: "which one?"}),
    ToolError,
  );
});

// --- authorization --------------------------------------------------------
// Access is the existing choke point, and denial must be indistinguishable from
// the document not existing, so ids stay unenumerable over MCP too.

test("an unshared document is invisible: not listed, and reads 404 rather than 403", () => {
  const stranger = createAgentPrincipal("stranger-bot");
  const meta = seeded("private", "secret plans\n");
  assert.equal(
    listDocumentsTool(stranger).some((entry) => entry.documentId === meta.id),
    false,
  );
  assert.throws(
    () => readDocumentTool(stranger, meta.id),
    (error: Error) => error instanceof ToolError && /not found/.test(error.message),
  );
});

test("a viewer may read but not edit", () => {
  const viewer = createAgentPrincipal("viewer-bot");
  const meta = seeded("read-only", "look but do not touch\n");
  setShare(meta.id, viewer.id, "viewer");
  assert.match(readDocumentTool(viewer, meta.id).content, /look but do not touch/);
  assert.throws(
    () => editDocumentTool(viewer, acceptUpdate, {documentId: meta.id, oldString: "touch", newString: "edit"}),
    (error: Error) => error instanceof ToolError && /not found/.test(error.message),
  );
});

test("list_documents reports folder paths so an agent can find a document by name", () => {
  const folder = createFolder("Specs", rootFolder.id);
  const meta = createDocument(folder.id, "auth-design", owner.id);
  const entry = listDocumentsTool(owner).find((item) => item.documentId === meta.id);
  assert.equal(entry?.path, "/Specs/auth-design");
});

test("an admin sees every document, as elsewhere in the app", () => {
  const admin = upsertHumanPrincipal("test", "admin", undefined, "admin");
  setPrincipalRole(admin.id, "admin");
  const meta = seeded("admin-visible", "anything\n");
  assert.ok(listDocumentsTool({...admin, role: "admin"}).some((entry) => entry.documentId === meta.id));
});
