import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

// Point the shared db/blob dir at a throwaway location before importing the
// modules under test (db.ts reads DATA_DIR at import time).
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "files-test-"));
const {saveFile, getFileMetadata, readFileBytes, listFiles, deleteFile, collectGarbage, FileValidationError} =
  await import("../../src/files.js");
const {createFolder, createDocument} = await import("../../src/directory.js");
const {blobExists} = await import("../../src/blob-store.js");

// A minimal valid 1x1 PNG.
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  ),
);
const pdf = new Uint8Array(Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "latin1"));

const rootId = 1; // The single Root folder is created with id 1.
const docA = createDocument(rootId, "doc-a.md")!.id;
const docB = createDocument(rootId, "doc-b.md")!.id;

test("attaching an image to a document stores metadata and a stable /api/files url", () => {
  const file = saveFile(png, "image/png", docA, {filename: "dot.png", uploadedBy: "agent-a"});
  assert.equal(file.mimeType, "image/png");
  assert.equal(file.size, png.byteLength);
  assert.equal(file.filename, "dot.png");
  assert.equal(file.documentId, docA);
  assert.equal(file.isImage, true);
  assert.equal(file.url, `/api/files/${file.id}`);
  assert.equal(typeof file.id, "number");
  assert.match(file.checksum, /^[a-f0-9]{64}$/);

  assert.equal(getFileMetadata(file.id)?.id, file.id);
  assert.deepEqual(new Uint8Array(readFileBytes(file.id)!), png);
});

test("attaching a non-image file works too", () => {
  const file = saveFile(pdf, "application/pdf", docA, {filename: "report.pdf"});
  assert.equal(file.mimeType, "application/pdf");
  assert.equal(file.isImage, false);
  assert.deepEqual(new Uint8Array(readFileBytes(file.id)!), pdf);
});

test("identical bytes attached to the same document dedupe to one record", () => {
  const a = saveFile(png, "image/png", docA, {filename: "first.png"});
  const b = saveFile(png, "image/png", docA, {filename: "second.png"});
  assert.equal(a.id, b.id); // same document + same bytes → same record
  assert.equal(b.filename, a.filename); // the requested name for the duplicate is ignored
});

test("identical bytes attached to two documents are distinct records over one blob", () => {
  const bytes = new Uint8Array(Buffer.from("shared-across-docs"));
  const a = saveFile(bytes, "text/plain", docA, {filename: "a.txt"});
  const b = saveFile(bytes, "text/plain", docB, {filename: "b.txt"});
  assert.notEqual(a.id, b.id); // one attachment per document...
  assert.equal(a.checksum, b.checksum); // ...over the same shared blob
  assert.equal(a.documentId, docA);
  assert.equal(b.documentId, docB);
});

test("distinct files that request the same name get a unique name in the document", () => {
  const a = saveFile(new Uint8Array(Buffer.from("alpha")), "text/plain", docA, {filename: "note.txt"});
  const b = saveFile(new Uint8Array(Buffer.from("beta")), "text/plain", docA, {filename: "note.txt"});
  assert.notEqual(a.id, b.id);
  assert.equal(a.filename, "note.txt");
  assert.equal(b.filename, "note-2.txt");
});

test("saveFile rejects mislabeled images and empties", () => {
  assert.throws(() => saveFile(new Uint8Array(Buffer.from("<html>")), "image/png", docA), FileValidationError);
  assert.throws(() => saveFile(new Uint8Array(), "image/png", docA), FileValidationError);
});

test("listFiles returns a document's attachments sorted by name", () => {
  const files = listFiles(docA);
  assert.ok(files.length >= 2);
  const names = files.map((file) => file.filename);
  assert.deepEqual([...names].sort(), names);
  // Attachments are scoped to their document.
  assert.equal(files.every((file) => file.documentId === docA), true);
});

test("deleteFile removes the row; GC then reclaims the orphaned blob", async () => {
  const file = saveFile(new Uint8Array(Buffer.from("garbage-me")), "text/plain", docA, {filename: "gc.txt"});
  assert.equal(blobExists(file.checksum), true);

  assert.equal(deleteFile(file.id), true);
  assert.equal(getFileMetadata(file.id), undefined);
  assert.equal(deleteFile(file.id), false);
  // The blob still exists until a sweep runs (GC owns blob lifecycle).
  assert.equal(blobExists(file.checksum), true);

  const removed = await collectGarbage();
  assert.ok(removed.includes(file.checksum));
  assert.equal(blobExists(file.checksum), false);
});

test("deleting one document's attachment keeps a blob another document still references", async () => {
  const bytes = new Uint8Array(Buffer.from("two-docs-one-blob"));
  const a = saveFile(bytes, "text/plain", docA, {filename: "keep-a.txt"});
  const b = saveFile(bytes, "text/plain", docB, {filename: "keep-b.txt"});
  assert.equal(a.checksum, b.checksum);
  assert.equal(deleteFile(a.id), true);
  const removed = await collectGarbage();
  assert.equal(removed.includes(a.checksum), false); // b still references it
  assert.equal(blobExists(b.checksum), true);
});
