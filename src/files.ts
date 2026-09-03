import {createHash} from "node:crypto";
import {database} from "./db.js";
// Importing the directory module for its side effects guarantees the `documents`
// table exists before the `files` table (which has a foreign key into it) is
// created below.
import "./directory.js";
import {readBlob, sweepOrphanBlobs, writeBlob} from "./blob-store.js";

// Files are ATTACHMENTS of documents. A file has no independent existence, owner,
// or sharing: it belongs to exactly one document, and its access, location, and
// lifecycle all derive from that document (see attachments-model.md). The raw bytes
// are content-addressed and deduped in the blob store; the row here binds a blob to
// a document with a display name. Deleting the document cascades its files away;
// GC reclaims a blob only when no row references its checksum.

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB per file.

// Image types we can safely render inline. Every other file is served as a
// download (Content-Disposition: attachment) so mislabeled content cannot execute
// in the browser. SVG is intentionally excluded: it can carry scripts (XSS).
const IMAGE_TYPES = new Map<string, (bytes: Uint8Array) => boolean>([
  ["image/png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38],
  ["image/webp", (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50], // "WEBP"
]);

database.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    checksum TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(document_id, filename)
  );
`);

export type FileMetadata = {
  id: number;
  documentId: number;
  checksum: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedBy: string | null;
  createdAt: string;
  url: string;
  isImage: boolean;
};

// A validation failure the caller can turn into a 4xx, distinct from an
// unexpected server error.
export class FileValidationError extends Error {}

const isImageType = (type: string) => IMAGE_TYPES.has(type);

const toMetadata = (row: Record<string, unknown>): FileMetadata => ({
  id: row.id as number,
  documentId: row.document_id as number,
  checksum: row.checksum as string,
  filename: row.filename as string,
  mimeType: row.mime_type as string,
  size: row.size as number,
  uploadedBy: (row.uploaded_by as string | null) ?? null,
  createdAt: row.created_at as string,
  url: `/api/files/${row.id as number}`,
  isImage: isImageType(row.mime_type as string),
});

// Reduce a client-supplied name to a bare, safe filename: no path separators or
// control characters, and no surrounding whitespace. Falls back to a
// checksum-derived name when nothing usable remains.
const sanitizeFilename = (filename: string | undefined, checksum: string) => {
  const base = (filename ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : `file-${checksum.slice(0, 8)}`;
};

// Ensure the name is unique within a document's attachments by appending "-2", "-3",
// … before the extension.
const uniqueFilename = (documentId: number, desired: string) => {
  const exists = database.prepare("SELECT 1 FROM files WHERE document_id = ? AND filename = ?");
  if (!exists.get(documentId, desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!exists.get(documentId, candidate)) return candidate;
  }
};

const getById = (id: number): Record<string, unknown> | undefined =>
  database.prepare("SELECT * FROM files WHERE id = ?").get(id) as Record<string, unknown> | undefined;

// Attach a file's bytes to a document. Byte-identical content already attached to
// the SAME document is returned as-is (idempotent, agent-friendly); attaching the
// same bytes to a different document is a separate record over the shared blob.
export const saveFile = (
  bytes: Uint8Array,
  mimeType: string,
  documentId: number,
  options: {filename?: string; uploadedBy?: string} = {},
): FileMetadata => {
  const type = mimeType.split(";")[0].trim().toLowerCase() || "application/octet-stream";
  if (bytes.byteLength === 0) throw new FileValidationError("file is empty");
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new FileValidationError(`file exceeds the ${MAX_FILE_BYTES}-byte limit`);
  }
  // If it claims to be an image, verify the bytes really are that image type, so a
  // mislabeled file cannot later be served inline under a trusted image type.
  const matchesMagic = IMAGE_TYPES.get(type);
  if (matchesMagic && !matchesMagic(bytes)) {
    throw new FileValidationError(`file content does not match declared type ${type}`);
  }

  const checksum = createHash("sha256").update(bytes).digest("hex");
  const existing = database.prepare("SELECT * FROM files WHERE document_id = ? AND checksum = ?").get(documentId, checksum) as
    | Record<string, unknown>
    | undefined;
  if (existing) return toMetadata(existing);

  const filename = uniqueFilename(documentId, sanitizeFilename(options.filename, checksum));
  writeBlob(checksum, bytes); // idempotent: a shared blob is written at most once.
  const createdAt = new Date().toISOString();
  const result = database
    .prepare(
      "INSERT INTO files (document_id, checksum, filename, mime_type, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(documentId, checksum, filename, type, bytes.byteLength, options.uploadedBy ?? null, createdAt);
  return toMetadata(getById(Number(result.lastInsertRowid))!);
};

export const getFileMetadata = (id: number): FileMetadata | undefined => {
  if (!Number.isInteger(id)) return undefined;
  const row = getById(id);
  return row ? toMetadata(row) : undefined;
};

export const readFileBytes = (id: number): Uint8Array | undefined => {
  const row = getById(id);
  return row ? readBlob(row.checksum as string) : undefined;
};

// A document's attachments, sorted by name.
export const listFiles = (documentId: number): FileMetadata[] => {
  const rows = database
    .prepare("SELECT * FROM files WHERE document_id = ? ORDER BY filename")
    .all(documentId) as Record<string, unknown>[];
  return rows.map(toMetadata);
};

// Detach (delete) one file record. The blob is reclaimed by the next GC sweep only
// if no other row references the same checksum.
export const deleteFile = (id: number): boolean => {
  if (!Number.isInteger(id)) return false;
  return database.prepare("DELETE FROM files WHERE id = ?").run(id).changes > 0;
};

// Mark-and-sweep GC: reclaim every blob no `files` row references. Because many
// rows can share a checksum, DISTINCT checksum is exactly the reference set.
export const collectGarbage = async (): Promise<string[]> => {
  const rows = database.prepare("SELECT DISTINCT checksum FROM files").all() as {checksum: string}[];
  return sweepOrphanBlobs(new Set(rows.map((row) => row.checksum)));
};
