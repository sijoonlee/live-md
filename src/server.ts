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
  listShares,
  removeShare,
  setShare,
  type DirectoryDocument,
} from "./directory.js";
import {MAX_DOCUMENT_CHARS, type LiveDocument} from "./document.js";
import {createZip, readZip, type ZipEntry} from "./zip.js";
import {findReferencedFileIds, rewriteAssetsToReferences, rewriteReferencesToAssets} from "./markdown-assets.js";
import {listActivity, recordActivity} from "./activity.js";
import {evictIdle, getLiveDocument, liveDocumentIds, snapshotAll} from "./document-registry.js";
import {can, type Action} from "./authz.js";
import {getAgentByName, getPrincipal, listPrincipals, listTokens, mintAgentToken, revokeToken, setPrincipalRole, verifyToken, type Principal} from "./auth.js";
import {createSession, deleteSession, getSessionPrincipal, upsertHumanPrincipal} from "./human-auth.js";
import {isAllowed, parseAllowlist} from "./allowlist.js";
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
const app = express();
const server = createServer(app);
const websocketServer = new WebSocketServer({server, path: "/ws"});
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");

app.use(express.json({limit: "2mb"}));
app.use(express.static(publicDir));

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (value: unknown) => {
  if (typeof value !== "string" || value.length === 0) throw new Error("update must be a base64 string");
  return new Uint8Array(Buffer.from(value, "base64"));
};
const integerId = (value: string) => /^\d+$/.test(value) ? Number(value) : NaN;

// --- Human auth (GitHub OAuth + opaque session cookie) --------------------
const githubClientId = process.env.GITHUB_CLIENT_ID ?? "";
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";
const githubCallbackUrl = process.env.GITHUB_CALLBACK_URL ?? `http://localhost:${port}/auth/callback`;
const allowlist = parseAllowlist(process.env.ALLOWED_GITHUB);
// Admins are bootstrapped from an env allowlist keyed on a trusted attribute
// (GitHub login or a verified email), so a spoofed unverified email can't escalate.
// Empty → no admins (isAllowed fails closed).
const adminAllowlist = parseAllowlist(process.env.ADMIN_GITHUB);
const secureCookies = process.env.NODE_ENV === "production";

const parseCookieHeader = (header: string | undefined): Record<string, string> =>
  Object.fromEntries(
    (header ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
      }),
  );
const parseCookies = (req: express.Request): Record<string, string> => parseCookieHeader(req.headers.cookie);

const setSessionCookie = (res: express.Response, id: string, expiresAt: string) =>
  res.cookie("sid", id, {httpOnly: true, sameSite: "lax", path: "/", secure: secureCookies, expires: new Date(expiresAt)});

const sessionPrincipal = (req: express.Request): Principal | undefined =>
  getSessionPrincipal(parseCookies(req).sid);

// Require a signed-in human. On failure writes a 401 and returns undefined.
const authedHuman = (req: express.Request, res: express.Response): Principal | undefined => {
  const principal = sessionPrincipal(req);
  if (!principal || principal.kind !== "human") {
    res.status(401).json({error: "sign in to perform this action"});
    return undefined;
  }
  return principal;
};

// A request is authenticated if it carries a valid agent bearer token OR a human
// session cookie. This is the baseline for the whole /api surface.
const principalFromRequest = (req: express.Request): Principal | undefined => {
  const match = /^Bearer (.+)$/.exec(req.header("authorization") ?? "");
  return (match ? verifyToken(match[1]) : undefined) ?? sessionPrincipal(req);
};

// Resolve the agent principal from the request's bearer token. On failure it
// writes a 401 and returns undefined, so callers do `if (!principal) return;`.
// This is what makes identity server-set: the authoring identity comes from the
// verified token, never from a client-supplied agentId.
const authedPrincipal = (req: express.Request, res: express.Response): Principal | undefined => {
  const match = /^Bearer (.+)$/.exec(req.header("authorization") ?? "");
  const principal = match ? verifyToken(match[1]) : undefined;
  if (!principal) {
    res.status(401).json({error: "a valid agent token is required (Authorization: Bearer <token>)"});
    return undefined;
  }
  return principal;
};
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
  authorId?: number,
) => {
  const nextRevision = live.applyUpdate(update, agentId, metadata, requestId);
  // Durable activity record + server-minted update id (M11/M12). Author is the
  // server-set principal, never client-supplied. Separate from the compactable CRDT log.
  const activityId = recordActivity({documentId, revision: nextRevision, authorId: authorId ?? null, authorLabel: agentId, metadata});
  broadcastToDocument(documentId, {
    type: "document_update",
    revision: nextRevision,
    agentId,
    update: toBase64(update),
    activityId,
  });
  return nextRevision;
};

// Resolve a document by id, enforcing the authorization choke point. Returns 404
// (never 403) both when the document is missing and when access is denied, so
// enumerable ids do not confirm which documents exist. Callers do
// `const doc = loadDocument(...); if (!doc) return;`.
type ResolvedDocument = {id: number; meta: DirectoryDocument; live: LiveDocument};
const loadDocument = (
  id: number,
  principal: Principal | undefined,
  res: express.Response,
  action: Action,
): ResolvedDocument | undefined => {
  const meta = getDocument(id);
  if (!meta || !can(principal, action, meta)) {
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

// Lock down the whole /api surface: every route requires authentication (a human
// session or an agent token) except the public sign-in status. Routes may enforce a
// stricter kind (e.g. token management requires a human) on top of this.
app.use("/api", (req, res, next) => {
  if (req.path === "/me") return next();
  if (!principalFromRequest(req)) return res.status(401).json({error: "authentication required"});
  return next();
});

// --- Id-keyed document content API ----------------------------------------
// The `/api/documents/:documentId/*` routes are the multi-document content surface.
// There is no un-parameterized alias: every request names its document, and access
// is decided per document by can() (404 for no access).

const sendDocumentState = (id: number, principal: Principal | undefined, res: express.Response) => {
  const doc = loadDocument(id, principal, res, "read");
  if (!doc) return;
  // documentId + name let the client title the document without a second request;
  // canEdit drives editor editability; canManage reveals the Share affordance.
  res.json({
    documentId: doc.id,
    name: doc.meta.name,
    ownerId: doc.meta.ownerId,
    // The requesting principal's own id, so a bearer-token caller (whose /api/me is
    // null) can stamp authorId on comments it writes. Attribution stays client-set.
    principalId: principal?.id ?? null,
    canEdit: can(principal, "write", doc.meta),
    canManage: can(principal, "manage", doc.meta),
    update: toBase64(doc.live.encodeState()),
    stateVector: toBase64(doc.live.encodeStateVector()),
    ...doc.live.getMetadata(),
  });
};

const syncDocument = (id: number, principal: Principal | undefined, req: express.Request, res: express.Response) => {
  const doc = loadDocument(id, principal, res, "read");
  if (!doc) return;
  try {
    const stateVector = fromBase64(req.body?.stateVector);
    res.json({update: toBase64(doc.live.encodeMissingState(stateVector)), ...doc.live.getMetadata()});
  } catch (error) {
    res.status(400).json({error: error instanceof Error ? error.message : "invalid state vector"});
  }
};

const sendDocumentUpdates = (id: number, principal: Principal | undefined, res: express.Response) => {
  const doc = loadDocument(id, principal, res, "read");
  if (!doc) return;
  res.json({updates: doc.live.getUpdates(), revision: doc.live.getRevision()});
};

app.get("/api/documents/:documentId/state", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) sendDocumentState(id, principalFromRequest(req), res);
});
app.post("/api/documents/:documentId/sync", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) syncDocument(id, principalFromRequest(req), req, res);
});
app.get("/api/documents/:documentId/updates", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) sendDocumentUpdates(id, principalFromRequest(req), res);
});

// Durable activity/history for a document (M12): a newest-first, cursor-paged feed of
// accepted updates with server-set authorship and the durable update id. Read access
// (same gate as the document). `before` = the last id of the previous page. Unlike
// `/updates` (the compactable in-memory CRDT tail), this survives snapshot compaction.
app.get("/api/documents/:documentId/history", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, principalFromRequest(req), res, "read");
  if (!doc) return;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  const before = typeof req.query.before === "string" ? req.query.before : undefined;
  const entries = listActivity(id, {limit: Number.isFinite(limit) ? limit : undefined, before}).map((entry) => {
    // Resolve the author to its CURRENT principal (renamed principals show their new
    // name); fall back to the stored label if the principal is gone.
    const principal = entry.authorId !== null ? getPrincipal(entry.authorId) : undefined;
    return {
      id: entry.id,
      revision: entry.revision,
      author: {
        id: entry.authorId,
        kind: principal?.kind ?? null,
        displayName: principal?.displayName ?? entry.authorLabel ?? `#${entry.authorId}`,
      },
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    };
  });
  res.json({entries});
});

// All principals (humans + agents) as id/kind/displayName, for resolving the authorId
// on comments (and similar UI labels) to a name. Workspace-wide visibility is
// intentional for this closed, allowlisted circle (see the trust model); any
// authenticated caller may read it (the global /api guard already requires that).
app.get("/api/principals", (_req, res) => {
  res.json({principals: listPrincipals().map((p) => ({id: p.id, kind: p.kind, displayName: p.displayName}))});
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
  // them, or the ownerless default) — never leak other principals' document names.
  const principal = principalFromRequest(req);
  const documents = listDocuments(folderId).filter((doc) => can(principal, "read", doc));
  return res.json({documents});
});

app.post("/api/folders/:folderId/documents", (req, res) => {
  const folderId = integerId(req.params.folderId);
  const name = directoryName(req.body?.name);
  if (Number.isNaN(folderId) || !name) return res.status(400).json({error: "folderId and name are required"});
  // The creating principal becomes the owner (the anchor for phase-3 authorization).
  const ownerId = principalFromRequest(req)?.id ?? null;
  try { return res.status(201).json(createDocument(folderId, name, ownerId)); } catch (error) { return res.status(409).json({error: error instanceof Error ? error.message : "document could not be created"}); }
});

app.patch("/api/documents/:documentId", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  // Renaming or moving a document is a write; only editors/owner/admin may do it.
  if (!loadDocument(id, principalFromRequest(req), res, "write")) return;
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
  if (!loadDocument(id, principalFromRequest(req), res, "manage")) return;
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
  const doc = loadDocument(id, principalFromRequest(req), res, "read");
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

// Per-principal write rate limit: ~20 updates/sec sustained, burst of 40.
const writeLimiter = createRateLimiter({capacity: 40, refillPerSec: 20});

const submitDocumentUpdate = (id: number, req: express.Request, res: express.Response) => {
  const principal = authedPrincipal(req, res);
  if (!principal) return;
  const doc = loadDocument(id, principal, res, "write");
  if (!doc) return;
  if (!writeLimiter.allow(String(principal.id))) {
    return res.status(429).json({error: "rate limit exceeded; slow down"});
  }
  // Server-set identity: the author is the token's principal, not req.body.agentId.
  const agentId = principal.displayName;
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
    const nextRevision = acceptUpdate(doc.id, doc.live, agentId, update, req.body?.metadata, requestId, principal.id);
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
  const doc = loadDocument(id, principalFromRequest(req), res, "write");
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
const createImportedDocument = (folderId: number, name: string, text: string, principal: Principal | undefined, res: express.Response) => {
  try {
    const created = createDocument(folderId, name, principal?.id ?? null);
    if (!created) return res.status(500).json({error: "document could not be created"});
    seedDocumentContent(created.id, getLiveDocument(created.id), text, principal?.displayName ?? "import");
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
  const principal = principalFromRequest(req);
  const queryName = typeof req.query.filename === "string" ? req.query.filename : undefined;
  const isZip = body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04;

  if (!isZip) {
    const text = body.toString("utf8");
    if (text.includes("\u0000")) return res.status(415).json({error: "import expects UTF-8 Markdown text, not binary"});
    if (text.length > MAX_DOCUMENT_CHARS) return res.status(413).json({error: `document exceeds the ${MAX_DOCUMENT_CHARS}-character limit`});
    return createImportedDocument(folderId, directoryName(queryName) ?? "Imported.md", text, principal, res);
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
    created = createDocument(folderId, name, principal?.id ?? null);
    if (!created) return res.status(500).json({error: "document could not be created"});
  } catch (error) {
    return res.status(409).json({error: error instanceof Error ? error.message : "document could not be created"});
  }

  const idByFilename = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.name.startsWith("assets/") || entry.name.length <= "assets/".length) continue;
    const filename = entry.name.slice("assets/".length);
    try {
      const file = saveFile(entry.bytes, guessMimeType(filename), created.id, {filename, uploadedBy: principal?.displayName});
      idByFilename.set(filename, file.id);
    } catch { /* skip an unreadable/invalid asset; its link stays as assets/<filename> */ }
  }
  text = rewriteAssetsToReferences(text, (filename) => {
    const id = idByFilename.get(filename);
    return id ? `/api/files/${id}` : null;
  });
  seedDocumentContent(created.id, getLiveDocument(created.id), text, principal?.displayName ?? "import");
  return res.status(201).json(created);
});

// A document's attachments. Requires READ on the doc (so listings are scoped to
// what the caller can see, same as the document itself).
app.get("/api/documents/:documentId/files", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, principalFromRequest(req), res, "read");
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
  if (!metadata || !doc || !can(principalFromRequest(req), "read", doc)) {
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
  const principal = principalFromRequest(req);
  if (!file || !doc || !can(principal, "read", doc)) return res.status(404).json({error: "file not found"});
  if (!can(principal, "write", doc)) return res.status(403).json({error: "editing this document is required to remove its attachments"});
  return deleteFile(id) ? res.status(204).end() : res.status(404).json({error: "file not found"});
});

// Redirect to GitHub for sign-in. A random state in a short-lived cookie is
// checked on callback to prevent CSRF.
// Only ever redirect back to a same-origin path (starts with a single "/"), so a
// crafted `returnTo` cannot bounce the user to another site after sign-in.
const safeReturnTo = (value: unknown): string | undefined =>
  typeof value === "string" && /^\/(?!\/)/.test(value) && value.length <= 512 ? value : undefined;

app.get("/auth/login", (req, res) => {
  if (!githubClientId) return res.status(500).send("GitHub OAuth is not configured (set GITHUB_CLIENT_ID).");
  const state = crypto.randomUUID();
  res.cookie("oauth_state", state, {httpOnly: true, sameSite: "lax", path: "/", secure: secureCookies, maxAge: 600_000});
  // Remember where the visitor was (e.g. a shared /documents/:id deep link) so the
  // callback can land them back there instead of the home page.
  const returnTo = safeReturnTo(req.query.returnTo);
  if (returnTo) res.cookie("oauth_return", returnTo, {httpOnly: true, sameSite: "lax", path: "/", secure: secureCookies, maxAge: 600_000});
  const params = new URLSearchParams({
    client_id: githubClientId,
    redirect_uri: githubCallbackUrl,
    scope: "read:user user:email",
    state,
  });
  return res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get("/auth/callback", async (req, res) => {
  const {code, state} = req.query;
  if (typeof code !== "string" || typeof state !== "string" || state !== parseCookies(req).oauth_state) {
    return res.status(400).send("Invalid OAuth state.");
  }
  res.clearCookie("oauth_state");
  try {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {accept: "application/json", "content-type": "application/json"},
      body: JSON.stringify({client_id: githubClientId, client_secret: githubClientSecret, code, redirect_uri: githubCallbackUrl}),
    });
    const accessToken = (await tokenResponse.json())?.access_token;
    if (!accessToken) return res.status(401).send("OAuth token exchange failed.");

    const ghHeaders = {authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "ai-collaborative-editor"};
    const user = await (await fetch("https://api.github.com/user", {headers: ghHeaders})).json();
    let email: string | undefined = user.email ?? undefined;
    if (!email) {
      const emails = await (await fetch("https://api.github.com/user/emails", {headers: ghHeaders})).json();
      if (Array.isArray(emails)) {
        email = (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified))?.email;
      }
    }
    if (!isAllowed(allowlist, user.login, email)) {
      return res.status(403).send("This GitHub account is not on the allowlist for this application.");
    }
    const principal = upsertHumanPrincipal("github", String(user.id), email, user.name || user.login);
    // Re-evaluate the role on every sign-in so allowlist changes take effect.
    setPrincipalRole(principal.id, isAllowed(adminAllowlist, user.login, email) ? "admin" : "member");
    const {id, expiresAt} = createSession(principal.id);
    setSessionCookie(res, id, expiresAt);
    const returnTo = safeReturnTo(parseCookies(req).oauth_return) ?? "/";
    res.clearCookie("oauth_return");
    return res.redirect(returnTo);
  } catch {
    return res.status(502).send("Could not complete GitHub sign-in.");
  }
});

app.post("/auth/logout", (req, res) => {
  deleteSession(parseCookies(req).sid);
  res.clearCookie("sid");
  return res.status(204).end();
});

app.get("/api/me", (req, res) => {
  const principal = sessionPrincipal(req);
  res.json({user: principal ? {id: principal.id, name: principal.displayName} : null});
});

// Test-only sign-in seam, enabled only when AUTH_DEV_LOGIN=1 (set by the e2e
// server, never in production). Lets tests establish a human session without the
// interactive GitHub flow.
if (process.env.AUTH_DEV_LOGIN === "1") {
  app.post("/auth/dev-login", (req, res) => {
    const name = directoryName(req.body?.name) ?? "Dev User";
    const principal = upsertHumanPrincipal("dev", name, undefined, name);
    setPrincipalRole(principal.id, req.body?.admin ? "admin" : "member");
    const {id, expiresAt} = createSession(principal.id);
    setSessionCookie(res, id, expiresAt);
    return res.json({user: {id: principal.id, name: principal.displayName}});
  });
}

// Agent token management. Gated to an authenticated human session: creating and
// revoking agent credentials is not something an anonymous caller may do.
app.get("/api/tokens", (req, res) => {
  if (!authedHuman(req, res)) return;
  res.json({tokens: listTokens()});
});

app.post("/api/tokens", (req, res) => {
  const human = authedHuman(req, res);
  if (!human) return;
  const name = directoryName(req.body?.name);
  if (!name) return res.status(400).json({error: "a token name (1-200 characters) is required"});
  // Returns the plaintext exactly once; it is never stored, only its hash.
  const {token, metadata} = mintAgentToken(name, human.id);
  return res.status(201).json({token, metadata});
});

app.delete("/api/tokens/:id", (req, res) => {
  if (!authedHuman(req, res)) return;
  const id = integerId(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({error: "id must be an integer"});
  return revokeToken(id) ? res.status(204).end() : res.status(404).json({error: "token not found"});
});

const listCursors = (id: number, principal: Principal | undefined, res: express.Response) => {
  const doc = loadDocument(id, principal, res, "read");
  if (!doc) return;
  doc.live.removeStaleCursors();
  res.json(doc.live.getCursors());
};

const publishCursor = (id: number, req: express.Request, res: express.Response) => {
  const principal = authedPrincipal(req, res);
  if (!principal) return;
  const doc = loadDocument(id, principal, res, "write");
  if (!doc) return;
  // Identity is server-set from the token; the :agentId path param is ignored.
  const agentId = principal.displayName;
  const length = doc.live.getText().length;
  const {anchor, head} = req.body ?? {};
  if (!Number.isInteger(anchor) || !Number.isInteger(head)) {
    return res.status(400).json({error: "anchor and head must be integers"});
  }
  if (anchor < 0 || head < 0 || anchor > length || head > length) {
    return res.status(400).json({error: `cursor positions must be between 0 and ${length}`});
  }
  const cursor = doc.live.upsertCursor(agentId, {anchor, head, label: req.body.label});
  broadcastToDocument(doc.id, {type: "cursor_update", cursor});
  return res.json(cursor);
};

app.get("/api/documents/:documentId/cursors", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) listCursors(id, principalFromRequest(req), res);
});
app.post("/api/documents/:documentId/cursor", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id !== undefined) publishCursor(id, req, res);
});

// --- Per-document sharing (manage-only) -----------------------------------
// Changing who has access is owner-or-admin only ("manage"), kept separate from
// editing content ("write") so an editor cannot escalate by adding themselves.
// loadDocument returns 404 for anyone without manage, so these endpoints don't
// confirm a document's existence to a non-manager.
const describeShares = (documentId: number) =>
  listShares(documentId).map((share) => {
    const p = getPrincipal(share.principalId);
    return {principalId: share.principalId, level: share.level, kind: p?.kind ?? null, displayName: p?.displayName ?? `#${share.principalId}`};
  });

app.get("/api/documents/:documentId/shares", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, principalFromRequest(req), res, "manage");
  if (!doc) return;
  const owner = doc.meta.ownerId !== null ? getPrincipal(doc.meta.ownerId) : undefined;
  return res.json({
    ownerId: doc.meta.ownerId,
    owner: owner ? {id: owner.id, kind: owner.kind, displayName: owner.displayName} : null,
    shares: describeShares(id),
  });
});

// Principals the manager can still add to this document: everyone except the owner
// and those already shared. Powers the Share dialog's picker (manage-only).
app.get("/api/documents/:documentId/share-candidates", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, principalFromRequest(req), res, "manage");
  if (!doc) return;
  const alreadyShared = new Set(listShares(id).map((share) => share.principalId));
  const candidates = listPrincipals()
    .filter((p) => p.id !== doc.meta.ownerId && !alreadyShared.has(p.id))
    .map((p) => ({principalId: p.id, kind: p.kind, displayName: p.displayName}));
  return res.json({candidates});
});

app.post("/api/documents/:documentId/shares", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, principalFromRequest(req), res, "manage");
  if (!doc) return;
  const level = req.body?.level;
  if (level !== "editor" && level !== "viewer") return res.status(400).json({error: "level must be 'editor' or 'viewer'"});
  // Resolve the grantee: a named agent, or an explicit principal id (either kind).
  let target: Principal | undefined;
  if (typeof req.body?.agentName === "string" && req.body.agentName.trim()) {
    target = getAgentByName(req.body.agentName.trim());
    if (!target) return res.status(404).json({error: "no agent with that name"});
  } else if (Number.isInteger(req.body?.principalId)) {
    target = getPrincipal(req.body.principalId);
    if (!target) return res.status(404).json({error: "no principal with that id"});
  } else {
    return res.status(400).json({error: "provide an agentName or a principalId"});
  }
  if (target.id === doc.meta.ownerId) return res.status(400).json({error: "the owner already has full access"});
  setShare(id, target.id, level);
  return res.status(201).json({principalId: target.id, level, displayName: target.displayName, kind: target.kind});
});

app.delete("/api/documents/:documentId/shares/:principalId", (req, res) => {
  const id = parseDocumentId(req.params.documentId, res);
  if (id === undefined) return;
  const doc = loadDocument(id, principalFromRequest(req), res, "manage");
  if (!doc) return;
  const principalId = integerId(req.params.principalId);
  if (Number.isNaN(principalId)) return res.status(400).json({error: "principalId must be an integer"});
  return removeShare(id, principalId) ? res.status(204).end() : res.status(404).json({error: "share not found"});
});

websocketServer.on("connection", (socket, request) => {
  // Authenticate the browser at the WebSocket handshake from its session cookie,
  // and join the room for the requested document (`?doc=<id>`, defaulting to the
  // legacy single document). The authorization choke point decides access; a
  // socket that may not read the document is refused and closed, matching the 404
  // the HTTP routes return. Edits are stamped with the principal, never a
  // client-supplied id.
  const principal = getSessionPrincipal(parseCookieHeader(request.headers.cookie).sid);
  const requestedId = new URL(request.url ?? "/ws", "http://localhost").searchParams.get("doc");
  const documentId = requestedId && /^\d+$/.test(requestedId) ? Number(requestedId) : NaN;
  const meta = Number.isNaN(documentId) ? undefined : getDocument(documentId);
  // Every connection must name a document it may read (`/ws?doc=<id>`); otherwise the
  // socket is refused and closed — there is no default document to fall back to.
  if (!meta || !can(principal, "read", meta)) {
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
    canEdit: can(principal, "write", meta),
    canManage: can(principal, "manage", meta),
  }));
  socket.on("close", () => leaveRoom(documentId, socket));
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "document_update") {
        if (!can(principal, "write", meta)) return socket.send(JSON.stringify({type: "error", error: "sign in to edit"}));
        acceptUpdate(documentId, live, principal!.displayName, fromBase64(message.update), message.metadata, undefined, principal!.id);
      } else if (message.type === "cursor_update") {
        if (!can(principal, "write", meta)) return;
        const cursor = live.upsertCursor(principal!.displayName, message.cursor ?? {});
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

server.listen(port, () => {
  console.log(`AI collaborative editor running at http://localhost:${port}`);
});
