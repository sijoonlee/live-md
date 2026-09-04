import "./env.js"; // Load .env before anything reads process.env.
import {createServer} from "node:http";
import {fileURLToPath} from "node:url";
import path from "node:path";
import express from "express";
import {WebSocketServer, WebSocket} from "ws";
import * as Y from "yjs";
import {
  createDocument,
  createFolder,
  deleteDocument,
  deleteFolder,
  getDocument,
  getFolder,
  listDocuments,
  listFolders,
  moveDocument,
  moveFolder,
  renameDocument,
  renameFolder,
  type DirectoryDocument,
} from "./directory.js";
import {MAX_DOCUMENT_CHARS, type LiveDocument} from "./document.js";
import {createZip, readZip, type ZipEntry} from "./zip.js";
import {findReferencedFileIds, rewriteAssetsToReferences, rewriteReferencesToAssets} from "./markdown-assets.js";
import {listActivity, recordActivity} from "./activity.js";
import {evictIdle, getLiveDocument, liveDocumentIds, snapshotAll} from "./document-registry.js";
import {authorFrom, LOCAL_AUTHOR} from "./author.js";
import {loopbackRejection, noteRejection, resolveBindHost} from "./loopback-guard.js";
import {mcpHandler} from "./mcp.js";
import {createRateLimiter} from "./rate-limit.js";
import {
  MAX_FILE_BYTES,
  FileValidationError,
  collectGarbage,
  deleteFile,
  getFileMetadata,
  listFiles,
  readFileBytes,
  saveFile,
} from "./files.js";

const port = Number(process.env.PORT ?? 3000);
// Throws (refusing to start) when AUTH_MODE=none is paired with a non-loopback bind.
const bindHost = resolveBindHost(process.env.HOST);
const app = express();
const server = createServer(app);
const websocketServer = new WebSocketServer({server, path: "/ws"});
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");

app.use(express.json({limit: "2mb"}));

// The only protection this build has. There is no authentication, so anything that
// can reach the port can read and rewrite every document — keep it to requests that
// actually originated locally, and not from a web page the user happens to be
// visiting or a hostname rebound to 127.0.0.1.
app.use((req, res, next) => {
  const reason = loopbackRejection({origin: req.headers.origin, host: req.headers.host}, port);
  if (!reason) return next();
  noteRejection(reason);
  return res.status(403).json({error: "refused: this server accepts local requests only"});
});
app.use(express.static(publicDir));

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (value: unknown) => {
  if (typeof value !== "string" || value.length === 0) throw new Error("update must be a base64 string");
  return new Uint8Array(Buffer.from(value, "base64"));
};
const integerId = (value: string) => /^\d+$/.test(value) ? Number(value) : NaN;


const directoryName = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200 ? value.trim() : undefined;

// A WebSocket "room" per document: a socket only receives updates for the document
// it joined, so edits never cross-talk between documents. The server owns the
// rooms; the registry consults `roomHasClients` before evicting so an open editor
// is never dropped.
const rooms = new Map<number, Set<WebSocket>>();
const roomHasClients = (documentId: number) => (rooms.get(documentId)?.size ?? 0) > 0;
const joinRoom = (documentId: number, socket: WebSocket) => {
  let room = rooms.get(documentId);
  if (!room) rooms.set(documentId, (room = new Set()));
  room.add(socket);
};
const leaveRoom = (documentId: number, socket: WebSocket) => {
  const room = rooms.get(documentId);
  if (!room) return;
  room.delete(socket);
  if (room.size === 0) rooms.delete(documentId);
};
const broadcastToDocument = (documentId: number, message: unknown) => {
  const room = rooms.get(documentId);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const client of room) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
};

const acceptUpdate = (
  documentId: number,
  live: LiveDocument,
  agentId: string,
  update: Uint8Array,
  metadata?: Record<string, unknown>,
  requestId?: string,
) => {
  const nextRevision = live.applyUpdate(update, agentId, metadata, requestId);
  // Durable activity record + server-minted update id (M11/M12). Author is the
  // server-set principal, never client-supplied. Separate from the compactable CRDT log.
  const activityId = recordActivity({documentId, revision: nextRevision, authorLabel: agentId, metadata});
  broadcastToDocument(documentId, {
    type: "document_update",
    revision: nextRevision,
    agentId,
    update: toBase64(update),
    activityId,
  });
  return nextRevision;
};

// Resolve a document by id. Still 404s for a missing document, so callers keep the
// shape `const doc = loadDocument(...); if (!doc) return;`.
type ResolvedDocument = {id: number; meta: DirectoryDocument; live: LiveDocument};
const loadDocument = (id: number, res: express.Response): ResolvedDocument | undefined => {
  const meta = getDocument(id);
  if (!meta) {
    res.status(404).json({error: "document not found"});
    return undefined;
  }
  return {id, meta, live: getLiveDocument(id)};
};
const parseDocumentId = (raw: string, res: express.Response): number | undefined => {
  const id = integerId(raw);
  if (Number.isNaN(id)) {
    res.status(400).json({error: "document id must be an integer"});
    return undefined;
  }
  return id;
};


// --- MCP -----------------------------------------------------------------
// How an agent living outside the browser (Claude Code in a terminal) works on the
// same document a person has open. It names itself with X-Agent-Id purely so the
// history log can attribute the edit.
app.post("/api/mcp", mcpHandler(acceptUpdate, (req) => authorFrom(req.headers)));

// The MCP client config for this server, so connecting an agent is a copy-paste
// rather than a documentation exercise.
app.get("/api/mcp/config", (_req, res) => {
  res.json({
    mcpServers: {
      "live-md": {
        type: "http",
        url: `http://localhost:${port}/api/mcp`,
        headers: {"X-Agent-Id": "claude-code"},
      },
    },
  });
});

// --- Id-keyed document content API ----------------------------------------
// The `/api/documents/:documentId/*` routes are the multi-document content surface.
// There is no un-parameterized alias: every request names its document, and access
// is decided per document by can() (404 for no access).

const sendDocumentState = (id: number, res: express.Response) => {
  const doc = loadDocument(id, res);
  if (!doc) return;
  // documentId + name let the client title the document without a second request;
  // canEdit drives editor editability; canManage reveals the Share affordance.
  res.json({
    documentId: doc.id,
    name: doc.meta.name,
      // Everyone who reaches this server may edit. The flags stay in the payload so the
    // browser client is identical between this build and the multi-user one.
    canEdit: true,
    canManage: true,
    update: toBase64(doc.live.encodeState()),
    stateVector: toBase64(doc.live.encodeStateVector()),
    ...doc.live.getMetadata(),
  });
};

const syncDocument = (id: number, req: express.Request, res: express.Response) => {
  const doc = loadDocument(id, res);
  if (!doc) return;
  try {
    const stateVector = fromBase64(req.body?.stateVector);
    res.json({update: toBase64(doc.live.encodeMissingState(stateVector)), ...doc.live.getMetadata()});
  } catch (error) {
    res.status(400).json({error: error instanceof Error ? error.message : "invalid state vector"});
  }
};

const sendDocumentUpdates = (id: number, res: express.Response) => {
  const doc = loadDocument(id, res);
  if (!doc) return;
  res.json({updates: doc.live.getUpdates(), revision: doc.live.getRevision()});
};

app.get("/api/documents/:documentId/state", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) sendDocumentState(id, res);
});
app.post("/api/documents/:documentId/sync", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) syncDocument(id, req, res);
});
app.get("/api/documents/:documentId/updates", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) sendDocumentUpdates(id, res);
});

// Durable activity/history for a document (M12): a newest-first, cursor-paged feed of
// accepted updates with server-set authorship and the durable update id. Read access
// (same gate as the document). `before` = the last id of the previous page. Unlike
// `/updates` (the compactable in-memory CRDT tail), this survives snapshot compaction.
app.get("/api/documents/:documentId/history", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, res);
  if (!doc) return;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  const before = typeof req.query.before === "string" ? req.query.before : undefined;
  const entries = listActivity(id, {limit: Number.isFinite(limit) ? limit : undefined, before}).map((entry) => {
    return {
      id: entry.id,
      revision: entry.revision,
      author: entry.authorLabel ?? "unknown",
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    };
  });
  res.json({entries});
});

app.get("/api/folders", (req, res) => {
  const parentFolderId = req.query.parentFolderId === undefined ? null : integerId(String(req.query.parentFolderId));
  if (Number.isNaN(parentFolderId)) return res.status(400).json({error: "parentFolderId must be an integer"});
  return res.json({folders: listFolders(parentFolderId)});
});

app.post("/api/folders", (req, res) => {
  const name = directoryName(req.body?.name);
  const parentFolderId = req.body?.parentFolderId === undefined || req.body?.parentFolderId === null ? null : Number(req.body.parentFolderId);
  if (!name || (parentFolderId !== null && !Number.isInteger(parentFolderId))) return res.status(400).json({error: "name and an optional integer parentFolderId are required"});
  try { return res.status(201).json(createFolder(name, parentFolderId)); } catch (error) { return res.status(409).json({error: error instanceof Error ? error.message : "folder could not be created"}); }
});

app.patch("/api/folders/:folderId", (req, res) => {
  const id = integerId(req.params.folderId);
  if (Number.isNaN(id)) return res.status(400).json({error: "folderId must be an integer"});
  try {
    const result = req.body?.parentFolderId !== undefined ? moveFolder(id, req.body.parentFolderId === null ? null : Number(req.body.parentFolderId)) : renameFolder(id, directoryName(req.body?.name) ?? "");
    if (!result) return res.status(404).json({error: "folder not found"});
    return res.json(result);
  } catch (error) { return res.status(409).json({error: error instanceof Error ? error.message : "folder could not be updated"}); }
});

app.delete("/api/folders/:folderId", (req, res) => {
  const id = integerId(req.params.folderId);
  if (Number.isNaN(id)) return res.status(400).json({error: "folderId must be an integer"});
  try { deleteFolder(id); return res.status(204).end(); } catch (error) { return res.status(409).json({error: error instanceof Error ? error.message : "folder could not be deleted"}); }
});

app.get("/api/folders/:folderId/documents", (req, res) => {
  const folderId = integerId(req.params.folderId);
  if (Number.isNaN(folderId)) return res.status(400).json({error: "folderId must be an integer"});
  // Scoped listing: only documents the caller may read (their own, shared with
  const documents = listDocuments(folderId);
  return res.json({documents});
});

app.post("/api/folders/:folderId/documents", (req, res) => {
  const folderId = integerId(req.params.folderId);
  const name = directoryName(req.body?.name);
  if (Number.isNaN(folderId) || !name) return res.status(400).json({error: "folderId and name are required"});
  try { return res.status(201).json(createDocument(folderId, name)); } catch (error) { return res.status(409).json({error: error instanceof Error ? error.message : "document could not be created"}); }
});

app.patch("/api/documents/:documentId", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  // Renaming or moving a document is a write; only editors/owner/admin may do it.
  if (!loadDocument(id, res)) return;
  try {
    const result = req.body?.folderId !== undefined ? moveDocument(id, Number(req.body.folderId)) : renameDocument(id, directoryName(req.body?.name) ?? "");
    if (!result) return res.status(404).json({error: "document not found"});
    return res.json(result);
  } catch (error) { return res.status(409).json({error: error instanceof Error ? error.message : "document could not be updated"}); }
});

app.delete("/api/documents/:documentId", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  // Deleting a document (and cascading its attachments) is owner/admin-only.
  if (!loadDocument(id, res)) return;
  deleteDocument(id);
  return res.status(204).end();
});

// A safe base filename derived from the document name: strip control/quote/slash
// characters that would break the Content-Disposition header or the path, and drop any
// `.md`/`.markdown` extension so the export can append its own (`.md` or `.zip`).
const exportBaseName = (name: string) => {
  const clean = name.replace(/[\x00-\x1f\x7f"\\/]/g, "").trim() || "document";
  return clean.replace(/\.(md|markdown)$/i, "") || "document";
};

// Export a document as Markdown (M19). Plain `.md` when nothing binary is referenced;
// otherwise a `.zip` bundle: `<name>.md` (links rewritten to `assets/<filename>`) plus
// the referenced attachments under `assets/`. `?format=md` forces the plain path (text
// with app-relative links intact). Read access required.
app.get("/api/documents/:documentId/export", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, res);
  if (!doc) return;
  const text = doc.live.getText();
  const base = exportBaseName(doc.meta.name);

  // Which referenced ids are actually this document's attachments (only those get bundled).
  const attachments = new Map(listFiles(id).map((file) => [file.id, file]));
  const referencedIds = findReferencedFileIds(text);
  const bundledIds = referencedIds.filter((rid) => attachments.has(rid));

  if (req.query.format === "md" || bundledIds.length === 0) {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.md"`);
    return res.send(text);
  }

  // Rewrite only the links pointing at this document's attachments; unknown/broken and
  // external references are left as-is (rewrite callback returns null).
  const rewritten = rewriteReferencesToAssets(text, (rid) => {
    const file = attachments.get(rid);
    return file ? `assets/${file.filename}` : null;
  });
  const entries: ZipEntry[] = [{name: `${base}.md`, bytes: new Uint8Array(Buffer.from(rewritten, "utf8"))}];
  for (const rid of bundledIds) {
    const bytes = readFileBytes(rid);
    if (bytes) entries.push({name: `assets/${attachments.get(rid)!.filename}`, bytes});
  }

  // Notes (export decisions): referenced-but-not-an-attachment refs are left in place;
  // orphan (unreferenced) attachments are not bundled. Surface both via a header.
  const brokenCount = referencedIds.length - bundledIds.length;
  const orphanCount = [...attachments.keys()].filter((aid) => !referencedIds.includes(aid)).length;
  const warnings: string[] = [];
  if (brokenCount > 0) warnings.push(`${brokenCount} referenced file(s) are not attachments of this document and were left as-is`);
  if (orphanCount > 0) warnings.push(`${orphanCount} unreferenced attachment(s) were not included`);
  if (warnings.length > 0) res.setHeader("X-Export-Warnings", encodeURIComponent(warnings.join("; ")));

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${base}.zip"`);
  return res.end(Buffer.from(createZip(entries)));
});

// Write rate limit: ~20 updates/sec sustained, burst of 40. Not a security control
// here — just a guard against a runaway client filling the update log.
const writeLimiter = createRateLimiter({capacity: 40, refillPerSec: 20});

const submitDocumentUpdate = (id: number, req: express.Request, res: express.Response) => {
  const doc = loadDocument(id, res);
  if (!doc) return;
  // The author labels the edit; it does not authorize it.
  const agentId = authorFrom(req.headers);
  if (!writeLimiter.allow(agentId)) {
    return res.status(429).json({error: "rate limit exceeded; slow down"});
  }
  const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : undefined;
  if (requestId && (requestId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(requestId))) {
    return res.status(400).json({error: "requestId contains invalid characters or is too long"});
  }
  // Restart-durable idempotency: a retried requestId resolves against the persisted
  // update row (M11 leftover), so a retry after a server restart returns the original
  // response instead of applying the update a second time.
  if (requestId) {
    const prior = doc.live.findProcessedRequest(requestId);
    if (prior) return res.json(prior);
  }

  try {
    const update = fromBase64(req.body?.update);
    const nextRevision = acceptUpdate(doc.id, doc.live, agentId, update, req.body?.metadata, requestId);
    return res.status(202).json({...doc.live.getMetadata(), revision: nextRevision});
  } catch (error) {
    return res.status(400).json({error: error instanceof Error ? error.message : "invalid update"});
  }
};

app.post("/api/documents/:documentId/updates", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) submitDocumentUpdate(id, req, res);
});

// Raw-body upload: the request body is the file bytes and the Content-Type header
// names the format. This avoids base64 overhead and needs no multipart parser.
// Global express.json() only consumes application/json, so it does not read the
// stream before this route's raw parser does.
const rawFileBody = express.raw({type: () => true, limit: MAX_FILE_BYTES});

// Attach a file to a document. Adding an attachment is editing the document, so it
// requires WRITE on the doc; the bytes are the raw request body.
app.post("/api/documents/:documentId/files", rawFileBody, (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, res);
  if (!doc) return;
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return res.status(400).json({error: "request body must be raw file bytes"});
  }
  const filename = typeof req.query.filename === "string" ? req.query.filename : undefined;
  const uploadedBy = typeof req.query.uploadedBy === "string" ? req.query.uploadedBy : undefined;
  try {
    const file = saveFile(new Uint8Array(body), req.header("content-type") ?? "", id, {filename, uploadedBy});
    return res.status(201).json(file);
  } catch (error) {
    if (error instanceof FileValidationError) return res.status(415).json({error: error.message});
    return res.status(500).json({error: "file could not be stored"});
  }
});

// Seed a freshly created document's content with imported text (M19). The text is
// inserted in chunks so each generated Yjs update stays under MAX_UPDATE_BYTES; the
// updates ride the normal accept path (persisted + broadcast). The seed replica is
// aligned to the live doc's (empty) state first so its item ids apply cleanly.
const IMPORT_CHUNK_CHARS = 200_000;
function seedDocumentContent(documentId: number, live: LiveDocument, text: string, author: string) {
  if (text.length === 0) return;
  const replica = new Y.Doc();
  Y.applyUpdate(replica, live.encodeState());
  const updates: Uint8Array[] = [];
  replica.on("update", (update: Uint8Array) => updates.push(update));
  const content = replica.getText("content");
  for (let offset = 0; offset < text.length; offset += IMPORT_CHUNK_CHARS) {
    content.insert(content.length, text.slice(offset, offset + IMPORT_CHUNK_CHARS));
  }
  for (const update of updates) acceptUpdate(documentId, live, author, update, {reason: "import"});
}

// Guess a stored file's MIME type from its name so re-imported images keep rendering
// inline (saveFile magic-verifies image types). SVG is intentionally absent — the files
// model excludes it as an XSS vector, so an .svg asset stores as a plain download.
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
};
const guessMimeType = (filename: string) => MIME_BY_EXT[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

// Create a document from Markdown text in a folder, seeding its content. Shared by the
// plain-`.md` and `.zip` import paths (the zip path rewrites links before calling this).
const createImportedDocument = (folderId: number, name: string, text: string, author: string, res: express.Response) => {
  try {
    const created = createDocument(folderId, name);
    if (!created) return res.status(500).json({error: "document could not be created"});
    seedDocumentContent(created.id, getLiveDocument(created.id), text, author);
    return res.status(201).json(created);
  } catch (error) {
    return res.status(409).json({error: error instanceof Error ? error.message : "document could not be created"});
  }
};

// Import a NEW document into a folder (M19). The raw body is either plain UTF-8 Markdown
// or a `.zip` bundle (detected by the PK magic): `<name>.md` plus `assets/…`. For a
// bundle, each asset is uploaded as an attachment and its `assets/<filename>` link is
// rewritten back to `/api/files/:id` — the inverse of export. Creating a document mirrors
// the create route (any authenticated principal; the importer becomes the owner).
app.post("/api/folders/:folderId/import", rawFileBody, (req, res) => {
  const folderId = integerId(req.params.folderId);
  if (Number.isNaN(folderId)) return res.status(400).json({error: "folderId must be an integer"});
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({error: "request body must be the file bytes"});
  const author = authorFrom(req.headers);
  const queryName = typeof req.query.filename === "string" ? req.query.filename : undefined;
  const isZip = body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04;

  if (!isZip) {
    const text = body.toString("utf8");
    if (text.includes("\u0000")) return res.status(415).json({error: "import expects UTF-8 Markdown text, not binary"});
    if (text.length > MAX_DOCUMENT_CHARS) return res.status(413).json({error: `document exceeds the ${MAX_DOCUMENT_CHARS}-character limit`});
    return createImportedDocument(folderId, directoryName(queryName) ?? "Imported.md", text, author, res);
  }

  // --- Zip bundle path ---
  let entries: ZipEntry[];
  try { entries = readZip(new Uint8Array(body)); } catch { return res.status(400).json({error: "invalid or corrupt zip bundle"}); }
  if (entries.some((entry) => entry.name.includes("..") || entry.name.startsWith("/"))) {
    return res.status(400).json({error: "zip contains an unsafe path"});
  }
  const mdEntry = entries.find((entry) => /^[^/]+\.(md|markdown)$/i.test(entry.name));
  if (!mdEntry) return res.status(400).json({error: "zip has no top-level Markdown file"});
  let text = Buffer.from(mdEntry.bytes).toString("utf8");
  if (text.includes("\u0000")) return res.status(415).json({error: "the Markdown entry is not UTF-8 text"});
  if (text.length > MAX_DOCUMENT_CHARS) return res.status(413).json({error: `document exceeds the ${MAX_DOCUMENT_CHARS}-character limit`});

  const name = directoryName(queryName ?? mdEntry.name) ?? "Imported.md";
  let created;
  try {
    created = createDocument(folderId, name);
    if (!created) return res.status(500).json({error: "document could not be created"});
  } catch (error) {
    return res.status(409).json({error: error instanceof Error ? error.message : "document could not be created"});
  }

  const idByFilename = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.name.startsWith("assets/") || entry.name.length <= "assets/".length) continue;
    const filename = entry.name.slice("assets/".length);
    try {
      const file = saveFile(entry.bytes, guessMimeType(filename), created.id, {filename, uploadedBy: author});
      idByFilename.set(filename, file.id);
    } catch { /* skip an unreadable/invalid asset; its link stays as assets/<filename> */ }
  }
  text = rewriteAssetsToReferences(text, (filename) => {
    const id = idByFilename.get(filename);
    return id ? `/api/files/${id}` : null;
  });
  seedDocumentContent(created.id, getLiveDocument(created.id), text, author);
  return res.status(201).json(created);
});

// A document's attachments. Requires READ on the doc (so listings are scoped to
// what the caller can see, same as the document itself).
app.get("/api/documents/:documentId/files", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, res);
  if (!doc) return;
  return res.json({files: listFiles(id)});
});

// Serve a file's bytes. Access is inherited from the file's document: readable iff
// the caller can read that document. A missing file, or one whose document the
// caller can't read, is a 404 — which the editor renders as "file was removed".
const serveFile = (rawId: string, req: express.Request, res: express.Response) => {
  const id = integerId(rawId);
  const metadata = Number.isNaN(id) ? undefined : getFileMetadata(id);
  const doc = metadata && getDocument(metadata.documentId);
  if (!metadata || !doc) {
    return res.status(404).json({error: "file not found"});
  }
  const bytes = readFileBytes(id);
  if (!bytes) return res.status(404).json({error: "file not found"});
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (metadata.isImage) {
    // Images may render inline (the document preview references them).
    res.setHeader("Content-Type", metadata.mimeType);
  } else {
    // Never inline-render an untrusted attachment: force a download so a mislabeled
    // .html/.svg cannot execute in the browser.
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${metadata.filename.replace(/"/g, "")}"`);
  }
  return res.send(Buffer.from(bytes));
};

app.get("/api/files/:id", (req, res) => serveFile(req.params.id, req, res));
// Alias kept for image references; resolves the same id-keyed store.
app.get("/api/images/:id", (req, res) => serveFile(req.params.id, req, res));

// Detach (delete) a file. Removing an attachment is editing the document, so it
// requires WRITE on the file's document.
app.delete("/api/files/:id", (req, res) => {
  const id = integerId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({error: "id must be an integer"});
  const file = getFileMetadata(id);
  const doc = file && getDocument(file.documentId);
  if (!file || !doc) return res.status(404).json({error: "file not found"});
  return deleteFile(id) ? res.status(204).end() : res.status(404).json({error: "file not found"});
});

// Redirect to GitHub for sign-in. A random state in a short-lived cookie is
// checked on callback to prevent CSRF.
// Who the browser is, as far as this build is concerned. Kept so the client's
// startup path is unchanged; there is nobody to sign in or out as.
app.get("/api/me", (_req, res) => {
  res.json({user: {name: LOCAL_AUTHOR}, authMode: "none"});
});

websocketServer.on("connection", (socket, request) => {
  // Authenticate the browser at the WebSocket handshake from its session cookie,
  // Join the room for the requested document (`?doc=<id>`). The loopback guard
  // applies here too: a WebSocket upgrade is a request like any other, and is the
  // one path that would otherwise let a foreign page drive the server.
  const reason = loopbackRejection({origin: request.headers.origin, host: request.headers.host}, port);
  if (reason) {
    noteRejection(reason);
    socket.send(JSON.stringify({type: "error", error: "refused: this server accepts local requests only"}));
    return socket.close();
  }
  const author = authorFrom(request.headers);
  const requestedId = new URL(request.url ?? "/ws", "http://localhost").searchParams.get("doc");
  const documentId = requestedId && /^\d+$/.test(requestedId) ? Number(requestedId) : NaN;
  const meta = Number.isNaN(documentId) ? undefined : getDocument(documentId);
  // Every connection must name an existing document (`/ws?doc=<id>`); there is no
  // default document to fall back to.
  if (!meta) {
    socket.send(JSON.stringify({type: "error", error: "document not found"}));
    return socket.close();
  }
  const live = getLiveDocument(documentId);
  joinRoom(documentId, socket);
  socket.send(JSON.stringify({
    type: "initial_state",
    documentId,
    name: meta.name,
    update: toBase64(live.encodeState()),
    ...live.getMetadata(),
    cursors: live.getCursors(),
    canEdit: true,
    canManage: true,
  }));
  socket.on("close", () => leaveRoom(documentId, socket));
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "document_update") {
        acceptUpdate(documentId, live, author, fromBase64(message.update), message.metadata);
      } else if (message.type === "cursor_update") {
        const cursor = live.upsertCursor(author, message.cursor ?? {});
        broadcastToDocument(documentId, {type: "cursor_update", cursor});
      }
    } catch {
      socket.send(JSON.stringify({type: "error", error: "invalid websocket message"}));
    }
  });
});

// Sweep stale cursors per resident document, broadcasting only to a room whose
// cursor set actually changed.
setInterval(() => {
  for (const id of liveDocumentIds()) {
    const live = getLiveDocument(id);
    const before = live.getCursors().length;
    live.removeStaleCursors();
    if (live.getCursors().length !== before) broadcastToDocument(id, {type: "cursors", cursors: live.getCursors()});
  }
}, 30_000).unref();

// Time-based compaction so an idle document with a few pending updates still gets
// snapshotted, complementing the volume trigger inside applyUpdate. The same pass
// evicts documents idle past the threshold (unless a client is still connected) so
// memory stays bounded as the number of documents grows.
const snapshotTimer = setInterval(() => {
  try {
    snapshotAll();
    evictIdle(roomHasClients);
  } catch (error) {
    console.warn("periodic snapshot failed", error);
  }
}, 60_000);
snapshotTimer.unref();

// Reclaim orphaned file blobs (rows deleted, folders cascaded away) on startup and
// then periodically. Mark-and-sweep only ever inspects `files` rows, so it cannot
// remove a blob a live document still references while that file's row survives.
const runGarbageCollection = () => {
  void collectGarbage().catch((error) => console.warn("blob garbage collection failed", error));
};
runGarbageCollection();
const garbageCollectionTimer = setInterval(runGarbageCollection, 5 * 60_000);
garbageCollectionTimer.unref();

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, writing final snapshots`);
  try {
    snapshotAll();
  } catch (error) {
    console.warn("final snapshot failed", error);
  }
  server.close(() => process.exit(0));
  // Don't hang forever on lingering WebSocket connections.
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

app.get("/{*splat}", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

server.listen(port, bindHost, () => {
  console.log(`live-md (local-only) running at http://localhost:${port}`);
});
