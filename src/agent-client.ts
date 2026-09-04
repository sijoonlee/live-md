import * as Y from "yjs";
import {
  addReply,
  addRootComment,
  deleteComment as deleteCommentInDoc,
  listComments as listCommentsInDoc,
  setResolved,
  updateCommentBody,
  type ResolvedComment,
} from "./comments.js";

export type AgentClientOptions = {
  baseUrl?: string;
  agentId: string;
  documentId: number;           // The document this client reads/edits (required)
  retries?: number;
  fetch?: typeof globalThis.fetch;
};

export type AgentUpdateMetadata = {
  reason?: string;
  sourceRun?: string;
  [key: string]: unknown;
};

export type FileMetadata = {id: number; documentId: number; checksum: string; filename: string; mimeType: string; size: number; uploadedBy: string | null; createdAt: string; url: string; isImage: boolean};
export type ExportResult = {bytes: Uint8Array; contentType: string; filename: string; warnings: string[]};
export type ActivityEntry = {
  id: string; // the durable, server-minted update id
  revision: number;
  author: {id: number | null; kind: string | null; displayName: string};
  metadata?: Record<string, unknown>;
  createdAt: string;
};
export type Folder = {id: number; parentFolderId: number | null; name: string; createdAt: string};
export type DirectoryDocument = {id: number; folderId: number; name: string; ownerId?: number | null; createdAt: string; updatedAt: string};

const encode = (value: Uint8Array) => Buffer.from(value).toString("base64");
const decode = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Small Node-compatible client for agents editing the shared Yjs document.
 * The client keeps a local Y.Doc and submits each local transaction as an update.
 */
export class AgentClient {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("content");
  private readonly baseUrl: string;
  private readonly agentId: string;
  // Base path for this client's document: the id-keyed API `/api/documents/:id`.
  private readonly documentBase: string;
  private readonly retries: number;
  private readonly requestFetch: typeof globalThis.fetch;
  private submission = Promise.resolve();
  private latestSubmission = Promise.resolve();
  private loaded = false;

  constructor(options: AgentClientOptions) {
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(options.agentId)) {
      throw new Error("agentId must be 1-100 characters using letters, numbers, ., _, :, or -");
    }
    if (!Number.isInteger(options.documentId) || options.documentId < 1) {
      throw new Error("documentId must be a positive integer");
    }
    this.baseUrl = (options.baseUrl ?? "http://localhost:3000").replace(/\/$/, "");
    this.agentId = options.agentId;
    this.documentBase = `/api/documents/${options.documentId}`;
    this.retries = options.retries ?? 3;
    this.requestFetch = options.fetch ?? globalThis.fetch;
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      const metadata = origin && typeof origin === "object" ? origin as AgentUpdateMetadata : undefined;
      const currentSubmission = this.submission
        .then(() => this.submitUpdate(update, metadata))
      this.latestSubmission = currentSubmission;
      this.submission = currentSubmission.catch(() => undefined);
    });
  }

  async load() {
    const response = await this.request(`${this.documentBase}/state`, {method: "GET"});
    Y.applyUpdate(this.doc, decode(response.update), "remote");
    this.loaded = true;
    return this.text.toString();
  }

  async sync() {
    const response = await this.request(`${this.documentBase}/sync`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({stateVector: encode(Y.encodeStateVector(this.doc))}),
    });
    Y.applyUpdate(this.doc, decode(response.update), "remote");
    this.loaded = true;
    return this.text.toString();
  }

  async insert(index: number, value: string, metadata?: AgentUpdateMetadata) {
    this.ensureLoaded();
    this.ensureRange(index, 0);
    this.doc.transact(() => this.text.insert(index, value), metadata ?? "agent-edit");
    await this.latestSubmission;
  }

  async delete(index: number, length: number, metadata?: AgentUpdateMetadata) {
    this.ensureLoaded();
    this.ensureRange(index, length);
    this.doc.transact(() => this.text.delete(index, length), metadata ?? "agent-edit");
    await this.latestSubmission;
  }

  async replace(index: number, length: number, value: string, metadata?: AgentUpdateMetadata) {
    this.ensureLoaded();
    this.ensureRange(index, length);
    this.doc.transact(() => {
      this.text.delete(index, length);
      this.text.insert(index, value);
    }, metadata ?? "agent-edit");
    await this.latestSubmission;
  }

  // --- Comments -------------------------------------------------------------
  // Comments live in a sibling "comments" type in the same Y.Doc as the text, so
  // each mutation is an ordinary update the existing submit pipeline ships to
  // `/api/documents/:id/updates` — no new endpoint. Reads reflect the last
  // load()/sync() (the SDK's poll-based read model, same as the text).

  /** All comments, each root's anchor resolved to a 1-based line (null = detached/reply). */
  listComments(): ResolvedComment[] {
    this.ensureLoaded();
    return listCommentsInDoc(this.doc);
  }

  /** Add a root comment anchored to the start of a 1-based line. Returns the new id. */
  async addComment({line, body}: {line: number; body: string}) {
    this.ensureLoaded();
    const charIndex = this.lineStartIndex(line);
    let id = "";
    this.doc.transact(() => {
      id = addRootComment(this.doc, {charIndex, author: this.agentId, body});
    }, "agent-comment");
    await this.latestSubmission;
    return id;
  }

  /** Reply to any existing comment (root or reply). Returns the new id. */
  async replyToComment(parentId: string, body: string) {
    this.ensureLoaded();
    let id = "";
    this.doc.transact(() => {
      id = addReply(this.doc, {parentId, author: this.agentId, body});
    }, "agent-comment");
    await this.latestSubmission;
    return id;
  }

  /** Edit a comment's body in place. */
  async updateComment(id: string, body: string) {
    this.ensureLoaded();
    this.doc.transact(() => updateCommentBody(this.doc, id, body), "agent-comment");
    await this.latestSubmission;
  }

  /** Resolve (or unresolve) a thread. Only affects roots. */
  async resolveComment(id: string, resolved = true) {
    this.ensureLoaded();
    this.doc.transact(() => setResolved(this.doc, id, resolved), "agent-comment");
    await this.latestSubmission;
  }

  /** Delete a comment (a root with replies is tombstoned; a leaf is removed). */
  async deleteComment(id: string) {
    this.ensureLoaded();
    this.doc.transact(() => deleteCommentInDoc(this.doc, id), "agent-comment");
    await this.latestSubmission;
  }

  /**
   * Attach raw file bytes to a document and return the stored file metadata,
   * including the `/api/files/:id` URL. Requires write access to the document.
   * Attaching identical bytes to the same document returns the existing record.
   */
  async uploadFile(
    documentId: number,
    bytes: Uint8Array,
    mimeType: string,
    options: {filename?: string} = {},
  ) {
    const params = new URLSearchParams({uploadedBy: this.agentId});
    if (options.filename) params.set("filename", options.filename);
    return await this.request(`/api/documents/${this.directoryId(documentId)}/files?${params.toString()}`, {
      method: "POST",
      headers: {"content-type": mimeType},
      body: bytes as unknown as BodyInit,
    }) as FileMetadata;
  }

  /**
   * Attach an image to a document and return its metadata. A thin wrapper over
   * `uploadFile`; reference the returned `url` from Markdown (e.g. `![alt](url)`).
   */
  async uploadImage(documentId: number, bytes: Uint8Array, mimeType: string, filename?: string) {
    return await this.uploadFile(documentId, bytes, mimeType, {filename});
  }

  /** List a document's attachments. Requires read access to the document. */
  async listFiles(documentId: number) {
    return (await this.request(`/api/documents/${this.directoryId(documentId)}/files`, {method: "GET"})).files as FileMetadata[];
  }

  /** Detach (delete) a file. Requires write access to its document. */
  async deleteFile(id: number) {
    await this.request(`/api/files/${this.directoryId(id)}`, {method: "DELETE"});
  }

  /**
   * Export this client's document (M19). Returns the raw bytes plus their content type
   * and download filename: a `text/markdown` `.md` when nothing binary is referenced,
   * or an `application/zip` `.zip` bundle (`<name>.md` + `assets/…`) when the document
   * references its attachments. `warnings` carries any export notes (broken/unreferenced
   * files). Pass `{ format: "md" }` to force plain Markdown with app-relative links.
     */
  async exportDocument(options: {format?: "md"} = {}): Promise<ExportResult> {
    const headers = {"x-agent-id": this.agentId};
    const query = options.format ? `?format=${options.format}` : "";
    const response = await this.requestFetch(`${this.baseUrl}${this.documentBase}/export${query}`, {headers});
    if (!response.ok) throw new Error(`export failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const disposition = response.headers.get("content-disposition") ?? "";
    const warnings = response.headers.get("x-export-warnings");
    return {
      bytes,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? "document.md",
      warnings: warnings ? decodeURIComponent(warnings).split("; ") : [],
    };
  }

  /**
   * The document's activity/history (M12): a newest-first page of accepted updates with
   * server-set authorship and each update's durable id. Requires read access. `before` is
   * the id of the last entry of the previous page, for cursoring.
   */
  async history(options: {limit?: number; before?: string} = {}): Promise<ActivityEntry[]> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.before) params.set("before", options.before);
    const query = params.toString() ? `?${params.toString()}` : "";
    return (await this.request(`${this.documentBase}/history${query}`, {method: "GET"})).entries as ActivityEntry[];
  }

  async setCursor(anchor: number, head = anchor, label = this.agentId) {
    await this.request(`${this.documentBase}/cursor`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({anchor, head, label}),
    });
  }

  async listFolders(parentFolderId?: number | null) {
    const query = parentFolderId === undefined || parentFolderId === null ? "" : `?parentFolderId=${this.directoryId(parentFolderId)}`;
    return (await this.request(`/api/folders${query}`, {method: "GET"})).folders as Folder[];
  }

  async createFolder(name: string, parentFolderId: number | null = null) {
    return await this.request("/api/folders", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: this.directoryName(name), parentFolderId: parentFolderId === null ? null : this.directoryId(parentFolderId)})}) as Folder;
  }

  async renameFolder(folderId: number, name: string) {
    return await this.request(`/api/folders/${this.directoryId(folderId)}`, {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({name: this.directoryName(name)})}) as Folder;
  }

  async moveFolder(folderId: number, parentFolderId: number | null) {
    return await this.request(`/api/folders/${this.directoryId(folderId)}`, {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({parentFolderId: parentFolderId === null ? null : this.directoryId(parentFolderId)})}) as Folder;
  }

  async deleteFolder(folderId: number) {
    await this.request(`/api/folders/${this.directoryId(folderId)}`, {method: "DELETE"});
  }

  async listDocuments(folderId: number) {
    return (await this.request(`/api/folders/${this.directoryId(folderId)}/documents`, {method: "GET"})).documents as DirectoryDocument[];
  }

  async createDocument(folderId: number, name: string) {
    return await this.request(`/api/folders/${this.directoryId(folderId)}/documents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: this.directoryName(name)})}) as DirectoryDocument;
  }

  /**
   * Import a NEW document into a folder (M19). Pass Markdown **text** for a plain import,
   * or the **bytes** of a `.zip` bundle (`<name>.md` + `assets/…`) to restore attachments
   * too — the server detects the zip and rewrites `assets/…` links back to `/api/files/:id`.
   * The importer becomes the owner. Returns the created document.
   */
  async importDocument(folderId: number, content: string | Uint8Array, options: {filename?: string} = {}) {
    const isBytes = content instanceof Uint8Array;
    const query = options.filename ? `?filename=${encodeURIComponent(options.filename)}` : "";
    return await this.request(`/api/folders/${this.directoryId(folderId)}/import${query}`, {
      method: "POST",
      headers: {"content-type": isBytes ? "application/zip" : "text/markdown"},
      body: (isBytes ? content : content) as unknown as BodyInit,
    }) as DirectoryDocument;
  }

  async renameDocument(documentId: number, name: string) {
    return await this.request(`/api/documents/${this.directoryId(documentId)}`, {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({name: this.directoryName(name)})}) as DirectoryDocument;
  }

  async moveDocument(documentId: number, folderId: number) {
    return await this.request(`/api/documents/${this.directoryId(documentId)}`, {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({folderId: this.directoryId(folderId)})}) as DirectoryDocument;
  }

  async deleteDocument(documentId: number) {
    await this.request(`/api/documents/${this.directoryId(documentId)}`, {method: "DELETE"});
  }

  private async submitUpdate(update: Uint8Array, metadata?: AgentUpdateMetadata) {
    await this.request(`${this.documentBase}/updates`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        agentId: this.agentId,
        requestId: `${this.agentId}-${crypto.randomUUID()}`,
        update: encode(update),
        metadata,
      }),
    });
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    // Name this agent on every request. Nothing verifies it — there is no
    // authentication in this build — it is what the activity log records as the author.
    const headers = {...(init.headers as Record<string, string> | undefined), "x-agent-id": this.agentId};
    const requestInit = {...init, headers};
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.requestFetch(`${this.baseUrl}${path}`, requestInit);
        const payload = response.status === 204 ? undefined : await response.json();
        if (!response.ok) throw new Error(payload?.error ?? `Request failed: ${response.status}`);
        return payload;
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) await sleep(100 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private ensureLoaded() {
    if (!this.loaded) throw new Error("Call load() before editing");
  }

  // Character index at the start of a 1-based line, clamped to the document.
  private lineStartIndex(line: number) {
    if (!Number.isInteger(line) || line < 1) throw new Error("line must be a positive integer");
    const s = this.text.toString();
    let index = 0;
    for (let n = 1; n < line; n += 1) {
      const nl = s.indexOf("\n", index);
      if (nl < 0) return s.length; // past the last line → clamp to end
      index = nl + 1;
    }
    return index;
  }

  private ensureRange(index: number, length: number) {
    if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || length < 0) {
      throw new Error("edit index and length must be non-negative integers");
    }
    if (index + length > this.text.length) {
      throw new Error(`edit range exceeds document length ${this.text.length}`);
    }
  }

  private directoryId(value: number) {
    if (!Number.isInteger(value) || value < 1) throw new Error("directory IDs must be positive integers");
    return value;
  }

  private directoryName(value: string) {
    if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 200) throw new Error("directory names must be 1-200 characters");
    return value.trim();
  }
}
