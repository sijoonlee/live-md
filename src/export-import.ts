import * as Y from "yjs";
import {MAX_DOCUMENT_CHARS, type LiveDocument} from "./document.js";
import {getLiveDocument} from "./document-registry.js";
import {createDocument, getDocument, type DirectoryDocument} from "./directory.js";
import {listFiles, readFileBytes, saveFile} from "./files.js";
import {findReferencedFileIds, rewriteAssetsToReferences, rewriteReferencesToAssets} from "./markdown-assets.js";
import {createZip, readZip, type ZipEntry} from "./zip.js";

// Markdown import/export, shared by the HTTP routes and the MCP tools. Extracted so
// both paths produce byte-identical bundles: a document exported from the browser and
// one exported by an agent are the same file, and either re-imports.
//
// Deliberately free of Express — these take and return bytes and signal failure by
// throwing, so each caller decides what a failure looks like (a status code, or a
// tool error the agent can act on).

// Carries the HTTP status the failure deserves, so the route keeps returning 415
// for "those are not Markdown bytes" and 413 for "too large" rather than flattening
// every refusal into 400. MCP ignores it and reports the message.
export class TransferError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const exportBaseName = (name: string) => {
  const clean = name.replace(/[\x00-\x1f\x7f"\\/]/g, "").trim() || "document";
  return clean.replace(/\.(md|markdown)$/i, "") || "document";
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
};
// Guess a stored file's MIME type from its name so re-imported images keep rendering
// inline (saveFile magic-verifies image types). SVG is intentionally absent — the
// files model excludes it as an XSS vector, so an .svg asset stores as a download.
export const guessMimeType = (filename: string) =>
  MIME_BY_EXT[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export type ExportResult = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  // Export decisions worth surfacing rather than silently applying.
  warnings: string[];
};

// A document as `.md`, or as a `.zip` bundle when it references its own attachments
// (`format: "md"` forces plain Markdown). Only links pointing at this document's
// attachments are rewritten; broken and external references are left exactly as they
// are, because rewriting a link we do not understand is worse than keeping it.
export const buildExport = (documentId: number, options: {format?: "md"} = {}): ExportResult => {
  const meta = getDocument(documentId);
  if (!meta) throw new TransferError(`document ${documentId} not found`);
  const text = getLiveDocument(documentId).getText();
  const base = exportBaseName(meta.name);

  const attachments = new Map(listFiles(documentId).map((file) => [file.id, file]));
  const referencedIds = findReferencedFileIds(text);
  const bundledIds = referencedIds.filter((id) => attachments.has(id));

  if (options.format === "md" || bundledIds.length === 0) {
    return {
      filename: `${base}.md`,
      contentType: "text/markdown; charset=utf-8",
      bytes: new Uint8Array(Buffer.from(text, "utf8")),
      warnings: [],
    };
  }

  const rewritten = rewriteReferencesToAssets(text, (id) => {
    const file = attachments.get(id);
    return file ? `assets/${file.filename}` : null;
  });
  const entries: ZipEntry[] = [{name: `${base}.md`, bytes: new Uint8Array(Buffer.from(rewritten, "utf8"))}];
  for (const id of bundledIds) {
    const bytes = readFileBytes(id);
    if (bytes) entries.push({name: `assets/${attachments.get(id)!.filename}`, bytes});
  }

  const brokenCount = referencedIds.length - bundledIds.length;
  const orphanCount = [...attachments.keys()].filter((id) => !referencedIds.includes(id)).length;
  const warnings: string[] = [];
  if (brokenCount > 0) warnings.push(`${brokenCount} referenced file(s) are not attachments of this document and were left as-is`);
  if (orphanCount > 0) warnings.push(`${orphanCount} unreferenced attachment(s) were not included`);

  return {filename: `${base}.zip`, contentType: "application/zip", bytes: createZip(entries), warnings};
};

// How a seeded update reaches the rest of the system. Injected rather than imported
// so this module does not depend on the server's broadcast machinery.
export type SeedUpdate = (
  documentId: number,
  live: LiveDocument,
  author: string,
  update: Uint8Array,
  metadata?: Record<string, unknown>,
) => unknown;

// Seed a new document's content. Inserted in chunks so each generated Yjs update
// stays under the per-update byte limit, and every chunk rides the normal accept
// path, so an import is persisted, broadcast and logged like any other edit.
const IMPORT_CHUNK_CHARS = 200_000;

export const seedDocumentContent = (
  documentId: number,
  live: LiveDocument,
  text: string,
  author: string,
  accept: SeedUpdate,
) => {
  if (text.length === 0) return;
  // Align the seed replica to the live doc's (empty) state first, so its item ids
  // apply cleanly.
  const replica = new Y.Doc();
  Y.applyUpdate(replica, live.encodeState());
  const updates: Uint8Array[] = [];
  replica.on("update", (update: Uint8Array) => updates.push(update));
  const content = replica.getText("content");
  for (let offset = 0; offset < text.length; offset += IMPORT_CHUNK_CHARS) {
    content.insert(content.length, text.slice(offset, offset + IMPORT_CHUNK_CHARS));
  }
  for (const update of updates) accept(documentId, live, author, update, {reason: "import"});
};

const looksLikeZip = (bytes: Uint8Array) =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

const asText = (bytes: Uint8Array): string => {
  const text = Buffer.from(bytes).toString("utf8");
  // A NUL byte means these are not the Markdown bytes the caller thinks they are.
  if (text.includes("\u0000")) throw new TransferError("expected UTF-8 Markdown text, not binary", 415);
  if (text.length > MAX_DOCUMENT_CHARS) {
    throw new TransferError(`document exceeds the ${MAX_DOCUMENT_CHARS}-character limit`, 413);
  }
  return text;
};

const create = (folderId: number, name: string): DirectoryDocument => {
  let created;
  try {
    created = createDocument(folderId, name);
  } catch (error) {
    throw new TransferError(error instanceof Error ? error.message : "document could not be created", 409);
  }
  if (!created) throw new TransferError("document could not be created", 500);
  return created;
};

export type ImportResult = {document: DirectoryDocument; attachments: number};

// Create a document from `.md` bytes or a `.zip` bundle (`<name>.md` + `assets/…`).
// Bundled assets are stored as attachments and their links rewritten to point at
// them; an asset that cannot be stored leaves its link as `assets/<filename>` rather
// than pointing somewhere wrong.
export const importBundle = (
  folderId: number,
  bytes: Uint8Array,
  options: {filename?: string; author: string; accept: SeedUpdate},
): ImportResult => {
  if (!looksLikeZip(bytes)) {
    const text = asText(bytes);
    const created = create(folderId, options.filename?.trim() || "Imported.md");
    seedDocumentContent(created.id, getLiveDocument(created.id), text, options.author, options.accept);
    return {document: created, attachments: 0};
  }

  let entries: ZipEntry[];
  try {
    entries = readZip(bytes);
  } catch {
    throw new TransferError("invalid or corrupt zip bundle");
  }
  if (entries.some((entry) => entry.name.includes("..") || entry.name.startsWith("/"))) {
    throw new TransferError("zip contains an unsafe path");
  }
  const mdEntry = entries.find((entry) => /^[^/]+\.(md|markdown)$/i.test(entry.name));
  if (!mdEntry) throw new TransferError("zip has no top-level Markdown file");
  const text = asText(mdEntry.bytes);

  const created = create(folderId, options.filename?.trim() || mdEntry.name);
  const idByFilename = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.name.startsWith("assets/") || entry.name.length <= "assets/".length) continue;
    const filename = entry.name.slice("assets/".length);
    try {
      const file = saveFile(entry.bytes, guessMimeType(filename), created.id, {filename, uploadedBy: options.author});
      idByFilename.set(filename, file.id);
    } catch {
      // Skip an unreadable or rejected asset; its link stays as assets/<filename>.
    }
  }
  const rewritten = rewriteAssetsToReferences(text, (filename) => {
    const id = idByFilename.get(filename);
    return id ? `/api/files/${id}` : null;
  });
  seedDocumentContent(created.id, getLiveDocument(created.id), rewritten, options.author, options.accept);
  return {document: created, attachments: idByFilename.size};
};
