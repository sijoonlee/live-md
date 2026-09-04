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
import {listActivity, recordActivity} from "./activity.js";
import {evictIdle, getLiveDocument, liveDocumentIds, snapshotAll} from "./document-registry.js";
import {authorFrom, LOCAL_AUTHOR} from "./author.js";
import {loopbackRejection, noteRejection, resolveBindHost} from "./loopback-guard.js";
import {mcpHandler} from "./mcp.js";
import {buildExport, importBundle, TransferError} from "./export-import.js";
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
) => {
  const nextRevision = live.applyUpdate(update, agentId, metadata);
  // Durable activity record + server-minted update id. The author label is set by
  // the server from the request. Separate from the compactable CRDT log.
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
  // canEdit is always true here; the field stays so the client reads the same in
  // both builds.
  res.json({
    documentId: doc.id,
    name: doc.meta.name,
      // Everyone who reaches this server may edit. The flags stay in the payload so the
    // browser client is identical between this build and the multi-user one.
    canEdit: true,
    update: toBase64(doc.live.encodeState()),
    stateVector: toBase64(doc.live.encodeStateVector()),
    ...doc.live.getMetadata(),
  });
};

app.get("/api/documents/:documentId/state", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) sendDocumentState(id, res);
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

// Export a document as Markdown (M19). Plain `.md` when nothing binary is referenced;
// otherwise a `.zip` bundle: `<name>.md` (links rewritten to `assets/<filename>`) plus
// the referenced attachments under `assets/`. `?format=md` forces the plain path (text
// with app-relative links intact). Read access required.
app.get("/api/documents/:documentId/export", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  if (!loadDocument(id, res)) return;
  const result = buildExport(id, {format: req.query.format === "md" ? "md" : undefined});
  res.setHeader("Content-Type", result.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
  if (result.warnings.length > 0) res.setHeader("X-Export-Warnings", encodeURIComponent(result.warnings.join("; ")));
  return res.end(Buffer.from(result.bytes));
});

// Raw-body upload: the request body is the file bytes and the Content-Type header
// names the format. This avoids base64 overhead and needs no multipart parser.
// Global express.json() only consumes application/json, so it does not read the
// stream before this route's raw parser does.
const rawFileBody = express.raw({type: () => true, limit: MAX_FILE_BYTES});

// Attach a file to a document; the bytes are the raw request body.
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
  const filename = typeof req.query.filename === "string" ? req.query.filename : undefined;
  try {
    const {document} = importBundle(folderId, new Uint8Array(body), {
      filename: directoryName(filename),
      author: authorFrom(req.headers),
      accept: acceptUpdate,
    });
    return res.status(201).json(document);
  } catch (error) {
    if (error instanceof TransferError) return res.status(error.status).json({error: error.message});
    return res.status(500).json({error: "import failed"});
  }
});

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
// Who the browser is, as far as this build is concerned. There is nobody to sign in
// or out as; the client shows this name beside the editor.
app.get("/api/me", (_req, res) => {
  res.json({user: {name: LOCAL_AUTHOR}});
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
