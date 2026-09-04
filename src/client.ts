import * as Y from "yjs";
import {basicSetup} from "codemirror";
import {markdown} from "@codemirror/lang-markdown";
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import {marked} from "marked";
import {foldEffect, unfoldEffect} from "@codemirror/language";
import {EditorState, RangeSetBuilder, StateEffect} from "@codemirror/state";
import {Decoration, DecorationSet, EditorView, GutterMarker, ViewPlugin, ViewUpdate, WidgetType, gutter} from "@codemirror/view";
import {addReply, addRootComment, commentsType, deleteComment as removeComment, listComments, setResolved, updateCommentBody, type ResolvedComment} from "./comments.js";

type Cursor = {agentId: string; label: string; anchor: number; head: number; color: string; lastSeenAt: string};
const clientId = "browser-" + Math.random().toString(36).slice(2, 8);
// The active document's local replica. Recreated on every document switch (a fresh
// Y.Doc per document — reusing one would merge two documents' content), so these
// are reassignable rather than const.
let localDoc: Y.Doc;
let sharedText: Y.Text;
let activeDocumentId: number | undefined;
const cursors = new Map<string, Cursor>();
const editorHost = document.getElementById("document") as HTMLDivElement;
let editor: EditorView | undefined;
let socket: WebSocket | undefined;
let applyingRemote = false;
let canEdit = false;
const pendingUpdates: string[] = [];
const refreshMermaid = StateEffect.define<void>();
// Dispatched to recompute the comment gutter when the `comments` type changes but the
// text does not (e.g. a collaborator's comment arriving over the socket), since that
// alone triggers no CodeMirror docChanged.
const refreshComments = StateEffect.define<void>();
const mermaidModes = new Map<number, boolean>();
const $ = (id: string) => document.getElementById(id)!;
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

type Folder = {id: number; parentFolderId: number | null; name: string};
type DirectoryDocument = {id: number; folderId: number; name: string};
type DirectoryFile = {id: number; documentId: number; filename: string; mimeType: string; size: number; url: string; isImage: boolean};

async function directoryRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not load the directory");
  return payload as T;
}

type DirectorySelection = {kind: "folder" | "document" | "file"; id: number | string; name: string; folderId?: number; documentId?: number; url?: string; isImage?: boolean};
let directorySelection: DirectorySelection | undefined;
let selectedMoveParent: number | undefined;

// Show only the context-menu actions that apply to the selected item's kind.
function updateContextMenu(kind: DirectorySelection["kind"]) {
  const show: Record<string, boolean> = {
    "directory-new-folder": kind === "folder",
    "directory-new-document": kind === "folder",
    "directory-import-document": kind === "folder",
    "directory-attach-file": kind === "document",
    "directory-insert-file": kind === "file",
    "directory-export-document": kind === "document",
    "directory-download-file": kind === "file",
    "directory-rename": kind === "folder" || kind === "document",
    "directory-move": kind === "folder" || kind === "document",
    "directory-delete": true,
  };
  for (const [id, visible] of Object.entries(show)) ($(id) as HTMLButtonElement).hidden = !visible;
}

function directoryRow(icon: string, name: string, className: string, selection?: DirectorySelection) {
  const row = document.createElement("div");
  row.className = className;
  const iconElement = document.createElement("span");
  iconElement.className = "directory-icon";
  iconElement.textContent = icon;
  const label = document.createElement("span");
  label.textContent = name;
  row.append(iconElement, label);
  if (selection) {
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      directorySelection = selection;
      updateContextMenu(selection.kind);
      const menu = $("directory-context-menu");
      menu.hidden = false;
      menu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
      menu.style.top = `${Math.min(event.clientY, window.innerHeight - 190)}px`;
    });
  }
  return row;
}

async function appendDirectoryFolder(folder: Folder, parent: HTMLElement, depth: number) {
  const row = directoryRow("▾", folder.name, "directory-row folder-row", {kind: "folder", id: folder.id, name: folder.name});
  row.style.setProperty("--directory-depth", String(depth));
  parent.append(row);
  const children = document.createElement("div");
  children.className = "directory-children";
  parent.append(children);
  const [folderPayload, documentPayload] = await Promise.all([
    directoryRequest<{folders: Folder[]}>(`/api/folders?parentFolderId=${folder.id}`),
    directoryRequest<{documents: DirectoryDocument[]}>(`/api/folders/${folder.id}/documents`),
  ]);
  for (const child of folderPayload.folders) await appendDirectoryFolder(child, children, depth + 1);
  for (const item of documentPayload.documents) {
    const documentRow = directoryRow("▤", item.name, "directory-row document-row", {kind: "document", id: item.id, name: item.name, folderId: item.folderId});
    documentRow.style.setProperty("--directory-depth", String(depth + 1));
    documentRow.dataset.documentId = String(item.id);
    if (item.id === activeDocumentId) documentRow.classList.add("active");
    documentRow.title = "Open document";
    documentRow.addEventListener("click", () => openDocument(item.id));
    children.append(documentRow);
    // A document's attachments render nested beneath it, so it is always clear
    // which document owns which file.
    const attachments = document.createElement("div");
    attachments.className = "directory-children";
    children.append(attachments);
    await appendAttachments(item.id, attachments, depth + 2);
  }
}

async function appendAttachments(documentId: number, parent: HTMLElement, depth: number) {
  const {files} = await directoryRequest<{files: DirectoryFile[]}>(`/api/documents/${documentId}/files`);
  for (const file of files) {
    const fileRow = directoryRow(file.isImage ? "▦" : "▨", file.filename, "directory-row file-row", {kind: "file", id: file.id, name: file.filename, documentId, url: file.url, isImage: file.isImage});
    fileRow.style.setProperty("--directory-depth", String(depth));
    fileRow.title = `${file.mimeType} · ${formatBytes(file.size)} — click to download`;
    fileRow.addEventListener("click", () => downloadFile(file.url, file.filename));
    parent.append(fileRow);
  }
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// Trigger a browser download (or inline open for images) of a stored file.
function downloadFile(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

// Insert a Markdown reference to a stored file at the editor's cursor. Images use
// an image reference (![…]) so the preview renders them inline; other files use a
// plain link. Insertion flows through the normal CodeMirror -> Yjs binding, so it
// syncs to other clients like any edit.
function insertFileReference(selection: DirectorySelection) {
  if (!editor || selection.kind !== "file") return;
  const url = selection.url ?? `/api/files/${selection.id}`;
  const label = selection.name.replace(/[\[\]\r\n]/g, "").trim() || "file";
  const reference = `${selection.isImage ? "!" : ""}[${label}](${url})`;
  const pos = editor.state.selection.main;
  editor.dispatch({changes: {from: pos.from, to: pos.to, insert: reference}, selection: {anchor: pos.from + reference.length}});
  editor.focus();
}

async function loadDirectory() {
  const tree = $("directory-tree");
  tree.replaceChildren();
  try {
    const payload = await directoryRequest<{folders: Folder[]}>("/api/folders");
    if (payload.folders.length === 0) {
      const empty = document.createElement("p");
      empty.className = "directory-status";
      empty.textContent = "No folders yet";
      tree.append(empty);
      return;
    }
    for (const folder of payload.folders) await appendDirectoryFolder(folder, tree, 0);
  } catch (error) {
    const message = document.createElement("p");
    message.className = "directory-status directory-error";
    message.textContent = error instanceof Error ? error.message : "Could not load Explorer";
    tree.append(message);
  }
}

const directorySidebar = $("directory-sidebar");
$("toggle-directory").addEventListener("click", () => {
  const visible = directorySidebar.hidden;
  directorySidebar.hidden = !visible;
  $("toggle-directory").setAttribute("aria-pressed", String(visible));
  if (!visible) return;
  renderDirectoryGate();
  if (currentUser) void loadDirectory();
});
$("directory-refresh").addEventListener("click", () => void loadDirectory());
$("directory-signin").addEventListener("click", signIn);
$("signin-screen-button").addEventListener("click", signIn);

// --- Human auth (sign-in state) -------------------------------------------
type Me = {id: number; name: string} | null;
let currentUser: Me = null;
// "none" when the server runs without authentication (a local single-user
// install): there is nobody to sign in or out as, so those affordances are hidden.
let authMode: "github" | "none" = "github";

// id → display name for every principal, so comment authors render as names. Loaded
// once signed in; workspace-wide visibility is intentional for this closed circle.
const principalNames = new Map<number, string>();
async function loadPrincipalNames() {
  try {
    const {principals} = await directoryRequest<{principals: {id: number; displayName: string}[]}>("/api/principals");
    principalNames.clear();
    for (const p of principals) principalNames.set(p.id, p.displayName);
  } catch { /* names are best-effort; fall back to #id */ }
}
const authorName = (id: number) => principalNames.get(id) ?? `#${id}`;

async function refreshAuth() {
  try {
    const me = await directoryRequest<{user: Me; authMode?: "github" | "none"}>("/api/me");
    currentUser = me.user;
    authMode = me.authMode ?? "github";
  } catch {
    currentUser = null;
  }
  if (currentUser) void loadPrincipalNames();
  renderAuthStatus();
  renderAppGate();
  renderTokenGate();
  renderDirectoryGate();
}

// The whole app is gated: anonymous visitors see a "Please sign in" screen instead
// of the document.
function renderAppGate() {
  const signedIn = !!currentUser;
  $("signin-screen").hidden = signedIn;
  $("app-main").hidden = !signedIn;
}

// The Explorer panel is gated like the token panel: show a sign-in prompt until
// signed in.
function renderDirectoryGate() {
  const signedIn = !!currentUser;
  $("directory-auth-gate").hidden = signedIn;
  $("directory-authed").hidden = !signedIn;
}

function renderAuthStatus() {
  const editMode = $("edit-mode");
  editMode.textContent = currentUser ? `Editing as ${currentUser.name}` : "Read-only — sign in to edit";
  editMode.classList.toggle("read-only", !currentUser);
  const host = $("auth-status");
  host.replaceChildren();
  if (currentUser) {
    const name = document.createElement("span");
    name.className = "auth-user";
    name.textContent = currentUser.name;
    if (authMode === "none") return void host.append(name);
    const out = document.createElement("button");
    out.type = "button";
    out.className = "auth-button";
    out.textContent = "Sign out";
    out.addEventListener("click", () => void signOut());
    host.append(name, out);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "auth-button";
    button.textContent = "Sign in with GitHub";
    button.addEventListener("click", signIn);
    host.append(button);
  }
}

function signIn() {
  // Preserve the current path (e.g. a shared /documents/:id link) so the OAuth
  // callback returns here instead of the home page.
  const returnTo = location.pathname + location.search;
  window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

async function signOut() {
  await fetch("/auth/logout", {method: "POST"});
  // Reload so the editor is re-created read-only (editability is fixed at creation).
  window.location.reload();
}

// Show the token form/list only when signed in; otherwise show the sign-in gate.
function renderTokenGate() {
  const signedIn = !!currentUser;
  $("token-auth-gate").hidden = signedIn;
  $("token-authed").hidden = !signedIn;
  if (signedIn) void loadTokens();
}

// --- Agent tokens panel ---------------------------------------------------
type TokenMetadata = {id: number; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null};

function formatTokenTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "never";
}

async function loadTokens() {
  const list = $("token-list");
  list.replaceChildren();
  try {
    const {tokens} = await directoryRequest<{tokens: TokenMetadata[]}>("/api/tokens");
    const active = tokens.filter((token) => !token.revokedAt);
    if (active.length === 0) {
      const empty = document.createElement("p");
      empty.className = "directory-status";
      empty.textContent = "No tokens yet";
      list.append(empty);
      return;
    }
    for (const token of active) {
      const row = document.createElement("div");
      row.className = "token-row";
      const info = document.createElement("div");
      info.className = "token-info";
      const name = document.createElement("strong");
      name.textContent = token.name;
      const meta = document.createElement("small");
      meta.textContent = `created ${formatTokenTime(token.createdAt)} · last used ${formatTokenTime(token.lastUsedAt)}`;
      info.append(name, meta);
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "token-revoke danger-action";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => void revokeToken(token));
      row.append(info, revoke);
      list.append(row);
    }
  } catch (error) {
    const message = document.createElement("p");
    message.className = "directory-status directory-error";
    message.textContent = error instanceof Error ? error.message : "Could not load tokens";
    list.append(message);
  }
}

async function revokeToken(token: TokenMetadata) {
  if (!window.confirm(`Revoke "${token.name}"? Any agent using it will stop working.`)) return;
  await directoryRequest(`/api/tokens/${token.id}`, {method: "DELETE"});
  await loadTokens();
}

async function createToken(event: Event) {
  event.preventDefault();
  const input = $("token-name-input") as HTMLInputElement;
  const name = input.value.trim();
  const errorElement = $("token-create-error");
  errorElement.hidden = true;
  if (!name) {
    errorElement.textContent = "Enter a token name.";
    errorElement.hidden = false;
    return;
  }
  try {
    const {token} = await directoryRequest<{token: string}>("/api/tokens", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name}),
    });
    input.value = "";
    // Show the plaintext once; it is unrecoverable afterward.
    ($("token-created-input") as HTMLInputElement).value = token;
    $("token-created").hidden = false;
    await loadTokens();
  } catch (error) {
    errorElement.textContent = error instanceof Error ? error.message : "Could not create token";
    errorElement.hidden = false;
  }
}

async function copyToken() {
  const input = $("token-created-input") as HTMLInputElement;
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    const button = $("token-copy");
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1500);
  } catch {
    // Clipboard blocked; the value is already selected for a manual copy.
  }
}

const tokenSidebar = $("token-sidebar");
$("toggle-tokens").addEventListener("click", () => {
  const visible = tokenSidebar.hidden;
  tokenSidebar.hidden = !visible;
  $("toggle-tokens").setAttribute("aria-pressed", String(visible));
  if (visible) void refreshAuth();
});
$("token-refresh").addEventListener("click", () => void refreshAuth());
$("token-signin").addEventListener("click", signIn);
$("token-create-form").addEventListener("submit", (event) => void createToken(event));
$("token-copy").addEventListener("click", () => void copyToken());
$("token-created-done").addEventListener("click", () => {
  $("token-created").hidden = true;
  ($("token-created-input") as HTMLInputElement).value = "";
});

// --- Document sharing (owner/admin only) ----------------------------------
type ShareEntry = {principalId: number; level: "editor" | "viewer"; kind: string | null; displayName: string};

async function openShareDialog() {
  if (activeDocumentId === undefined || !canManageActive) return;
  $("share-error").hidden = true;
  await loadShares();
  $("share-dialog").hidden = false;
}

type ShareCandidate = {principalId: number; kind: string; displayName: string};

// Populate the "who to add" dropdown from the server (everyone not already on the
// document), so the user picks instead of typing a name.
async function loadShareCandidates() {
  const select = $("share-principal") as HTMLSelectElement;
  const addButton = $("share-add") as HTMLButtonElement;
  select.replaceChildren();
  try {
    const {candidates} = await directoryRequest<{candidates: ShareCandidate[]}>(`/api/documents/${activeDocumentId}/share-candidates`);
    if (candidates.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No one else to add";
      select.append(option);
      select.disabled = true;
      addButton.disabled = true;
      return;
    }
    select.disabled = false;
    addButton.disabled = false;
    for (const candidate of candidates) {
      const option = document.createElement("option");
      option.value = String(candidate.principalId);
      option.textContent = `${candidate.displayName}${candidate.kind === "agent" ? " (agent)" : ""}`;
      select.append(option);
    }
  } catch {
    select.replaceChildren();
    select.disabled = true;
    addButton.disabled = true;
  }
}

async function loadShares() {
  const list = $("share-list");
  list.replaceChildren();
  await loadShareCandidates();
  try {
    const data = await directoryRequest<{owner: {displayName: string} | null; shares: ShareEntry[]}>(`/api/documents/${activeDocumentId}/shares`);
    const ownerRow = document.createElement("div");
    ownerRow.className = "share-row share-owner";
    const ownerName = document.createElement("span");
    ownerName.textContent = data.owner ? data.owner.displayName : "This app (legacy document)";
    const ownerBadge = document.createElement("em");
    ownerBadge.textContent = "owner";
    ownerRow.append(ownerName, ownerBadge);
    list.append(ownerRow);
    if (data.shares.length === 0) {
      const empty = document.createElement("p");
      empty.className = "directory-status";
      empty.textContent = "No one else has access.";
      list.append(empty);
    }
    for (const share of data.shares) {
      const row = document.createElement("div");
      row.className = "share-row";
      const name = document.createElement("span");
      name.textContent = `${share.displayName}${share.kind === "agent" ? " (agent)" : ""}`;
      const level = document.createElement("em");
      level.textContent = share.level;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "token-revoke danger-action";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => void removeShareEntry(share.principalId));
      row.append(name, level, remove);
      list.append(row);
    }
  } catch (error) {
    const message = document.createElement("p");
    message.className = "directory-status directory-error";
    message.textContent = error instanceof Error ? error.message : "Could not load sharing";
    list.append(message);
  }
}

async function addShare(event: Event) {
  event.preventDefault();
  const principalId = Number(($("share-principal") as HTMLSelectElement).value);
  const level = ($("share-level") as HTMLSelectElement).value;
  $("share-error").hidden = true;
  if (!principalId) return;
  try {
    await directoryRequest(`/api/documents/${activeDocumentId}/shares`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({principalId, level}),
    });
    await loadShares();
  } catch (error) {
    $("share-error").textContent = error instanceof Error ? error.message : "Could not add access";
    $("share-error").hidden = false;
  }
}

async function removeShareEntry(principalId: number) {
  await directoryRequest(`/api/documents/${activeDocumentId}/shares/${principalId}`, {method: "DELETE"});
  await loadShares();
}

$("share-document").addEventListener("click", () => void openShareDialog());
$("share-close").addEventListener("click", () => { $("share-dialog").hidden = true; });
$("share-dialog").addEventListener("click", (event) => { if (event.target === $("share-dialog")) $("share-dialog").hidden = true; });
$("share-add-form").addEventListener("submit", (event) => void addShare(event));

$("toggle-comments").addEventListener("click", () => toggleCommentsPanel());
$("toggle-activity").addEventListener("click", () => toggleActivityPanel());
$("comments-show-resolved").addEventListener("change", (event) => {
  showResolvedComments = (event.target as HTMLInputElement).checked;
  renderCommentsPanel();
});

const contextMenu = $("directory-context-menu");
document.addEventListener("click", () => { contextMenu.hidden = true; });
contextMenu.addEventListener("click", (event) => event.stopPropagation());

function closeMoveDialog() {
  $("move-dialog").hidden = true;
  selectedMoveParent = undefined;
  $("move-confirm").setAttribute("disabled", "true");
}

async function createDirectoryItem(kind: "folder" | "document") {
  if (!directorySelection) return;
  const parentFolderId = directorySelection.kind === "folder" ? directorySelection.id : directorySelection.folderId;
  if (!parentFolderId) return;
  const name = await requestName(kind === "folder" ? "New folder" : "New document", "Enter a name");
  if (!name?.trim()) return;
  const created = await directoryRequest<{id: number}>(kind === "folder" ? "/api/folders" : `/api/folders/${parentFolderId}/documents`, {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify(kind === "folder" ? {name: name.trim(), parentFolderId} : {name: name.trim()}),
  });
  await loadDirectory();
  // Open a freshly created document right away.
  if (kind === "document") openDocument(created.id);
}

async function renameDirectoryItem() {
  if (!directorySelection) return;
  const name = await requestName("Rename", "Enter a new name", directorySelection.name);
  if (!name?.trim()) return;
  const path = directorySelection.kind === "folder" ? `/api/folders/${directorySelection.id}` : `/api/documents/${directorySelection.id}`;
  await directoryRequest(path, {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({name: name.trim()})});
  // Keep the header title in sync when the active document is the one renamed.
  if (directorySelection.kind === "document" && directorySelection.id === activeDocumentId) setDocumentTitle(name.trim());
  await loadDirectory();
}

let nameDialogResolve: ((name: string | undefined) => void) | undefined;
function requestName(title: string, description: string, initial = "") {
  $("name-dialog-title").textContent = title;
  $("name-dialog-description").textContent = description;
  const input = $("name-dialog-input") as HTMLInputElement;
  input.value = initial;
  $("name-dialog-error").hidden = true;
  $("name-dialog").hidden = false;
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return new Promise<string | undefined>((resolve) => { nameDialogResolve = resolve; });
}

function closeNameDialog(value?: string) {
  $("name-dialog").hidden = true;
  const resolve = nameDialogResolve;
  nameDialogResolve = undefined;
  resolve?.(value);
}

$("name-cancel").addEventListener("click", () => closeNameDialog());
$("name-save").addEventListener("click", () => {
  const value = ($("name-dialog-input") as HTMLInputElement).value.trim();
  if (!value) {
    $("name-dialog-error").textContent = "Enter a name.";
    $("name-dialog-error").hidden = false;
    return;
  }
  closeNameDialog(value);
});
$("name-dialog-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("name-save").click();
  if (event.key === "Escape") closeNameDialog();
});

async function deleteDirectoryItem() {
  if (!directorySelection) return;
  const warning =
    directorySelection.kind === "folder" ? "Delete this folder and all its contents?" :
    directorySelection.kind === "file" ? "Remove this attachment? Any reference to it in the document will show as removed." :
    "Delete this document?";
  if (!window.confirm(warning)) return;
  const path =
    directorySelection.kind === "folder" ? `/api/folders/${directorySelection.id}` :
    directorySelection.kind === "file" ? `/api/files/${directorySelection.id}` :
    `/api/documents/${directorySelection.id}`;
  const deletingActiveDocument = directorySelection.kind === "document" && directorySelection.id === activeDocumentId;
  await directoryRequest(path, {method: "DELETE"});
  await loadDirectory();
  // If we just deleted the open document, fall back to the default document.
  if (deletingActiveDocument) {
    history.pushState({}, "", "/");
    await activateDocument(undefined); // back to the welcome/empty state
  }
}

// Attach one or more files to the selected document via a hidden <input type=file>.
let attachTargetDocumentId: number | undefined;
function attachToSelectedDocument() {
  if (directorySelection?.kind !== "document") return;
  attachTargetDocumentId = directorySelection.id as number;
  ($("file-upload-input") as HTMLInputElement).click();
}

async function handleFileInputChange(input: HTMLInputElement) {
  const files = Array.from(input.files ?? []);
  input.value = ""; // Allow re-selecting the same file later.
  if (files.length === 0 || attachTargetDocumentId === undefined) return;
  const documentId = attachTargetDocumentId;
  try {
    for (const file of files) {
      const response = await fetch(`/api/documents/${documentId}/files?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: {"content-type": file.type || "application/octet-stream"},
        body: file,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "File attach failed");
    }
    await loadDirectory();
  } catch (error) {
    showUploadError(error instanceof Error ? error.message : "File attach failed");
  }
}

// Import a Markdown file as a new document in the selected folder (M19). Reads the
// file text in the browser and POSTs it to the folder import endpoint, then refreshes
// the Explorer and opens the new document.
let importTargetFolderId: number | undefined;
function importToSelectedFolder() {
  if (directorySelection?.kind !== "folder") return;
  importTargetFolderId = directorySelection.id as number;
  ($("import-md-input") as HTMLInputElement).click();
}

async function handleImportInputChange(input: HTMLInputElement) {
  const file = input.files?.[0];
  input.value = ""; // Allow re-selecting the same file later.
  if (!file || importTargetFolderId === undefined) return;
  const folderId = importTargetFolderId;
  try {
    // A .zip bundle carries binary attachments, so send its raw bytes; plain Markdown
    // goes as text. The server detects the zip by magic bytes either way.
    const isZip = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
    const body = isZip ? await file.arrayBuffer() : await file.text();
    const response = await fetch(`/api/folders/${folderId}/import?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: {"content-type": isZip ? "application/zip" : "text/markdown"},
      body,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Import failed");
    await loadDirectory();
    openDocument(payload.id); // open the freshly imported document (pushes /documents/:id)
  } catch (error) {
    showUploadError(error instanceof Error ? error.message : "Import failed");
  }
}

async function renderMoveTargets(parent: HTMLElement, current: DirectorySelection, depth = 0) {
  const folders = (await directoryRequest<{folders: Folder[]}>(depth === 0 ? "/api/folders" : `/api/folders?parentFolderId=${parent.dataset.folderId}`)).folders;
  for (const folder of folders) {
    if (current.kind === "folder" && folder.id === current.id) continue;
    const target = document.createElement("button");
    target.type = "button";
    target.className = "move-target";
    target.style.setProperty("--directory-depth", String(depth));
    target.textContent = `▾  ${folder.name}`;
    target.addEventListener("click", () => {
      selectedMoveParent = folder.id;
      document.querySelectorAll(".move-target.selected").forEach((element) => element.classList.remove("selected"));
      target.classList.add("selected");
      $("move-confirm").removeAttribute("disabled");
    });
    parent.append(target);
    const child = document.createElement("div");
    child.dataset.folderId = String(folder.id);
    parent.append(child);
    await renderMoveTargets(child, current, depth + 1);
  }
}

async function openMoveDialog() {
  if (!directorySelection) return;
  $("move-dialog-item").textContent = `Choose a destination for “${directorySelection.name}”.`;
  const targets = $("move-targets");
  targets.replaceChildren();
  $("move-error").hidden = true;
  try {
    await renderMoveTargets(targets, directorySelection);
    $("move-dialog").hidden = false;
  } catch (error) {
    $("move-error").textContent = error instanceof Error ? error.message : "Could not load folders";
    $("move-error").hidden = false;
    $("move-dialog").hidden = false;
  }
}

$("directory-new-folder").addEventListener("click", () => void createDirectoryItem("folder"));
$("directory-new-document").addEventListener("click", () => void createDirectoryItem("document"));
$("directory-attach-file").addEventListener("click", () => attachToSelectedDocument());
$("directory-import-document").addEventListener("click", () => importToSelectedFolder());
$("directory-insert-file").addEventListener("click", () => {
  if (directorySelection?.kind === "file") insertFileReference(directorySelection);
  contextMenu.hidden = true;
});
$("directory-download-file").addEventListener("click", () => {
  if (directorySelection?.kind === "file") downloadFile(`/api/files/${directorySelection.id}`, directorySelection.name);
});
$("directory-export-document").addEventListener("click", () => {
  if (directorySelection?.kind !== "document") return;
  const fallback = /\.(md|markdown)$/i.test(directorySelection.name) ? directorySelection.name : `${directorySelection.name}.md`;
  void exportDocumentDownload(directorySelection.id as number, fallback);
  contextMenu.hidden = true;
});

// Fetch the export (plain .md or a .zip bundle), download it using the server-provided
// filename, and surface any export notes (broken/unreferenced attachments).
async function exportDocumentDownload(id: number, fallbackName: string) {
  try {
    const response = await fetch(`/api/documents/${id}/export`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Export failed");
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
    const url = URL.createObjectURL(blob);
    downloadFile(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 10_000); // keep the URL alive until the download starts
    const warnings = response.headers.get("x-export-warnings");
    if (warnings) showUploadError(`Exported with notes: ${decodeURIComponent(warnings)}`);
  } catch (error) {
    showUploadError(error instanceof Error ? error.message : "Export failed");
  }
}
$("file-upload-input").addEventListener("change", (event) => void handleFileInputChange(event.target as HTMLInputElement));
$("import-md-input").addEventListener("change", (event) => void handleImportInputChange(event.target as HTMLInputElement));
$("directory-rename").addEventListener("click", () => void renameDirectoryItem());
$("directory-delete").addEventListener("click", () => void deleteDirectoryItem());
$("directory-move").addEventListener("click", () => void openMoveDialog());
$("move-cancel").addEventListener("click", closeMoveDialog);
$("move-dialog").addEventListener("click", (event) => { if (event.target === $("move-dialog")) closeMoveDialog(); });
$("move-confirm").addEventListener("click", async () => {
  if (!directorySelection || selectedMoveParent === undefined) return;
  try {
    const path =
      directorySelection.kind === "folder" ? `/api/folders/${directorySelection.id}` :
      directorySelection.kind === "file" ? `/api/files/${directorySelection.id}` :
      `/api/documents/${directorySelection.id}`;
    const body = directorySelection.kind === "folder" ? {parentFolderId: selectedMoveParent} : {folderId: selectedMoveParent};
    await directoryRequest(path, {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
    closeMoveDialog();
    await loadDirectory();
  } catch (error) {
    $("move-error").textContent = error instanceof Error ? error.message : "Could not move item";
    $("move-error").hidden = false;
  }
});

function renderMetadata(metadata: {revision?: number; updatedAt?: string; lastUpdatedBy?: string}) {
  $("revision").textContent = String(metadata.revision ?? 0);
  $("last-updated-by").textContent = metadata.lastUpdatedBy || "—";
  $("updated-at").textContent = metadata.updatedAt ? new Date(metadata.updatedAt).toLocaleString() : "—";
}

function sendCursor() {
  if (!editor) return;
  const selection = editor.state.selection.main;
  const message = JSON.stringify({type: "cursor_update", agentId: clientId, cursor: {anchor: selection.from, head: selection.to, label: "Browser editor"}});
  if (socket?.readyState === WebSocket.OPEN) socket.send(message);
}

function flushUpdates() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  while (pendingUpdates.length > 0) socket.send(JSON.stringify({type: "document_update", agentId: clientId, update: pendingUpdates.shift(), metadata: {reason: "CodeMirror editor input"}}));
}

type PreviewBlock = {type: "mermaid" | "table" | "image"; start: number; bodyStart: number; bodyEnd: number; source: string; src?: string; alt?: string};

// Only allow image sources we can render safely: our own stored images, other
// relative paths, and http(s). This rejects javascript:, data:, and similar
// schemes before the URL ever reaches an <img> element.
function safeImageSrc(src: string): string | null {
  const value = src.trim();
  if (/^(https?:)?\/\//i.test(value)) return value;
  if (/^\/(?!\/)/.test(value) || /^\.{0,2}\//.test(value)) return value;
  return null;
}

function findPreviewBlocks(value: string): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  const pattern = /^[ \t]{0,3}```mermaid[ \t]*\r?\n([\s\S]*?)^[ \t]{0,3}```[ \t]*(?:\r?\n|$)/gim;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    const openingEnd = start + match[0].indexOf("\n") + 1;
    const closingStart = start + match[0].lastIndexOf("```");
    blocks.push({type: "mermaid", start, bodyStart: openingEnd, bodyEnd: closingStart, source: match[1].trim()});
  }
  const lines = value.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const delimiter = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes("|") || !delimiter.test(lines[index + 1])) continue;
    let end = index + 2;
    while (end < lines.length && lines[end].trim() !== "" && lines[end].includes("|")) end += 1;
    blocks.push({type: "table", start: offsets[index], bodyStart: offsets[index], bodyEnd: offsets[end - 1] + lines[end - 1].length, source: lines.slice(index, end).join("\n")});
    index = end - 1;
  }
  // Markdown image tokens: ![alt](src) with an optional "title".
  const imagePattern = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  for (const match of value.matchAll(imagePattern)) {
    const start = match.index ?? 0;
    blocks.push({type: "image", start, bodyStart: start, bodyEnd: start + match[0].length, source: match[0], src: match[2], alt: match[1]});
  }
  return blocks.sort((left, right) => left.start - right.start);
}

class PreviewWidget extends WidgetType {
  constructor(private readonly block: PreviewBlock) { super(); }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-preview-widget";
    const output = document.createElement("div");
    output.className = "cm-preview-output";
    output.textContent = this.block.type === "mermaid" ? "Rendering Mermaid…" : this.block.type === "image" ? "" : "Rendering table…";
    wrapper.append(output);
    if (this.block.type === "mermaid") {
      void mermaid.render(`cm-mermaid-${this.block.start}`, this.block.source).then(({svg}) => { output.innerHTML = svg; }).catch((error: unknown) => {
        output.textContent = error instanceof Error ? error.message : "Could not render Mermaid diagram";
        output.className = "cm-preview-output cm-preview-error";
      });
    } else if (this.block.type === "image") {
      const src = safeImageSrc(this.block.src ?? "");
      if (!src) {
        output.textContent = `Blocked image source: ${this.block.src ?? ""}`;
        output.className = "cm-preview-output cm-preview-error";
      } else {
        const image = document.createElement("img");
        image.className = "cm-preview-image";
        image.alt = this.block.alt ?? "";
        image.loading = "lazy";
        image.addEventListener("error", () => {
          // The referenced file 404s when it has been removed (or the viewer can't
          // read it): show a clear placeholder rather than a broken image.
          output.textContent = "This file was removed or is unavailable.";
          output.className = "cm-preview-output cm-preview-error";
        });
        image.src = src;
        output.append(image);
      }
    } else {
      void Promise.resolve(marked.parse(this.block.source, {gfm: true})).then((html: string) => { output.innerHTML = DOMPurify.sanitize(html); }).catch(() => { output.textContent = "Could not render table"; });
    }
    return wrapper;
  }

  eq(other: PreviewWidget) { return this.block.start === other.block.start && this.block.source === other.block.source && this.block.type === other.block.type; }
  ignoreEvent() { return false; }
}

class PreviewMarker extends GutterMarker {
  constructor(private readonly block: PreviewBlock, private readonly preview: boolean) { super(); }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.className = "cm-preview-gutter-button";
    button.type = "button";
    button.textContent = this.preview ? "≡" : "▶";
    const label = this.block.type === "mermaid" ? "Mermaid" : this.block.type === "image" ? "image" : "table";
    button.title = this.preview ? `Show ${label} source` : `Show ${label} preview`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => {
      mermaidModes.set(this.block.start, !this.preview);
      const foldFrom = view.state.doc.lineAt(this.block.bodyStart).from;
      const foldTo = view.state.doc.lineAt(this.block.bodyEnd).to;
      const effects = this.preview ? [unfoldEffect.of({from: foldFrom, to: foldTo}), refreshMermaid.of()] : [foldEffect.of({from: foldFrom, to: foldTo}), refreshMermaid.of()];
      view.dispatch({effects});
    });
    return button;
  }
  eq(other: PreviewMarker) { return this.block.start === other.block.start && this.preview === other.preview && this.block.source === other.block.source && this.block.type === other.block.type; }
}

class MermaidPlugin {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshMermaid)))) this.decorations = this.build(update.view);
  }
  build(view: EditorView) {
    const decorations = [];
    for (const block of findPreviewBlocks(view.state.doc.toString())) {
      const preview = mermaidModes.get(block.start) ?? false;
      if (preview && block.bodyEnd > block.bodyStart) {
        decorations.push(Decoration.widget({widget: new PreviewWidget(block), side: 1}).range(Math.max(block.start, block.bodyStart - 1)));
      }
    }
    return Decoration.set(decorations, true);
  }
}

const mermaidPlugin = ViewPlugin.fromClass(MermaidPlugin);
const mermaidExtension = [mermaidPlugin, EditorView.decorations.of((view) => view.plugin(mermaidPlugin)?.decorations ?? Decoration.none)];
const mermaidGutter = gutter({
  class: "cm-preview-gutter",
  markers: (view) => {
    const builder = new RangeSetBuilder<GutterMarker>();
    for (const block of findPreviewBlocks(view.state.doc.toString())) {
      builder.add(view.state.doc.lineAt(block.start).from, view.state.doc.lineAt(block.start).from, new PreviewMarker(block, mermaidModes.get(block.start) ?? false));
    }
    return builder.finish();
  },
});

// A 💬 marker for a line carrying one or more unresolved comments (with a count when
// several). Clicking opens the thread popover for that line.
class CommentMarker extends GutterMarker {
  constructor(private readonly line: number, private readonly count: number) { super(); }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-comment-gutter-marker";
    button.textContent = this.count > 1 ? `💬${this.count}` : "💬";
    button.title = this.count > 1 ? `${this.count} comments on this line` : "1 comment on this line";
    button.addEventListener("mousedown", (event) => event.preventDefault()); // keep editor focus/selection
    button.addEventListener("click", () => openThreadPopover(this.line, button, view));
    return button;
  }
  eq(other: CommentMarker) { return this.line === other.line && this.count === other.count; }
}

// A faint "+" affordance on the cursor's line (editable docs, line has no comment yet),
// opening the composer to add a root comment there.
class AddCommentMarker extends GutterMarker {
  constructor(private readonly line: number) { super(); }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-comment-gutter-add";
    button.textContent = "+";
    button.title = "Comment on this line";
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => openComposerPopover(this.line, button, view));
    return button;
  }
  eq(other: AddCommentMarker) { return this.line === other.line; }
}

// Count unresolved root comments per 1-based line for the active document. Roots whose
// anchor no longer resolves (detached) are skipped here; the panel (step 5) surfaces them.
function unresolvedCommentsByLine(): Map<number, number> {
  const byLine = new Map<number, number>();
  if (!localDoc) return byLine;
  for (const comment of listComments(localDoc)) {
    if (comment.parentId !== null || comment.resolved || comment.line === null) continue;
    byLine.set(comment.line, (byLine.get(comment.line) ?? 0) + 1);
  }
  return byLine;
}

const commentGutter = gutter({
  class: "cm-comment-gutter",
  markers: (view) => {
    const builder = new RangeSetBuilder<GutterMarker>();
    const byLine = unresolvedCommentsByLine();
    // The add affordance sits on the cursor's line when editable and that line has no
    // comment yet (a line with a comment shows 💬 instead — add-another lives in the popover).
    const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    const addLine = canEdit && !byLine.has(cursorLine) ? cursorLine : undefined;
    const lines = new Set<number>([...byLine.keys()]);
    if (addLine !== undefined) lines.add(addLine);
    for (const line of [...lines].sort((a, b) => a - b)) {
      if (line < 1 || line > view.state.doc.lines) continue;
      const at = view.state.doc.line(line).from;
      builder.add(at, at, byLine.has(line) ? new CommentMarker(line, byLine.get(line)!) : new AddCommentMarker(line));
    }
    return builder.finish();
  },
});

// --- Comment threads: composer, popover, mutations (step 4) ----------------
// All writes go through the local Y.Doc under a "comment-edit" origin, so they queue
// on the outgoing update stream exactly like text edits (see initDoc's update handler)
// and are gated server-side by the same document write permission.
function commentMutate(fn: () => void) {
  localDoc.transact(fn, "comment-edit");
}

let commentPopover: HTMLElement | undefined;
function closeCommentPopover() {
  commentPopover?.remove();
  commentPopover = undefined;
  document.removeEventListener("mousedown", onDocMouseDownForPopover, true);
}
function onDocMouseDownForPopover(event: MouseEvent) {
  if (commentPopover && !commentPopover.contains(event.target as Node)) closeCommentPopover();
}

// Position a freshly built popover next to the gutter marker that opened it, kept
// within the viewport, and wire outside-click / Escape to dismiss it.
function showPopover(panel: HTMLElement, anchorEl: HTMLElement) {
  closeCommentPopover();
  panel.className = "comment-popover";
  document.body.appendChild(panel);
  const rect = anchorEl.getBoundingClientRect();
  const top = Math.min(rect.top, window.innerHeight - panel.offsetHeight - 8);
  const left = Math.min(rect.right + 6, window.innerWidth - panel.offsetWidth - 8);
  panel.style.top = `${Math.max(8, top)}px`;
  panel.style.left = `${Math.max(8, left)}px`;
  panel.addEventListener("keydown", (event) => { if (event.key === "Escape") closeCommentPopover(); });
  commentPopover = panel;
  document.addEventListener("mousedown", onDocMouseDownForPopover, true);
}

const formatTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
};

// A one-comment block (root or reply), indented by depth. Includes a Delete control for
// editors. Replies of this comment are rendered recursively by the caller.
function renderCommentEntry(comment: ResolvedComment, depth: number): HTMLElement {
  const entry = document.createElement("div");
  entry.className = "comment-entry";
  entry.style.marginLeft = `${depth * 14}px`;
  const meta = document.createElement("div");
  meta.className = "comment-meta";
  meta.textContent = `${authorName(comment.authorId)} · ${formatTime(comment.createdAt)}`;
  const body = document.createElement("div");
  body.className = "comment-body";
  body.textContent = comment.body;
  entry.append(meta, body);
  if (canEdit) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "comment-link comment-delete";
    del.textContent = "Delete";
    del.addEventListener("click", () => { commentMutate(() => removeComment(localDoc, comment.id)); rerenderOpenThread(); });
    entry.appendChild(del);
  }
  return entry;
}

// The line + anchor element a popover is currently bound to, so a mutation can rebuild
// it in place (comments change under it as we add/reply/resolve/delete).
let openThreadContext: {line: number; anchor: HTMLElement; view: EditorView} | undefined;
function rerenderOpenThread() {
  if (openThreadContext) openThreadPopover(openThreadContext.line, openThreadContext.anchor, openThreadContext.view);
}

function openThreadPopover(line: number, anchorEl: HTMLElement, view: EditorView) {
  openThreadContext = {line, anchor: anchorEl, view};
  const all = listComments(localDoc);
  const roots = all.filter((c) => c.parentId === null && c.line === line && !c.resolved);
  const panel = document.createElement("div");
  const header = document.createElement("div");
  header.className = "comment-popover-header";
  header.textContent = `Comments on line ${line}`;
  panel.appendChild(header);

  if (roots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "comment-empty";
    empty.textContent = "No open comments on this line.";
    panel.appendChild(empty);
  }

  for (const root of roots) {
    const thread = document.createElement("div");
    thread.className = "comment-thread";
    // Root then its full reply subtree, each sorted by createdAt.
    const render = (comment: ResolvedComment, depth: number) => {
      thread.appendChild(renderCommentEntry(comment, depth));
      const replies = all.filter((c) => c.parentId === comment.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const reply of replies) render(reply, depth + 1);
    };
    render(root, 0);

    if (canEdit) {
      // Reply box.
      const reply = document.createElement("textarea");
      reply.className = "comment-input";
      reply.rows = 2;
      reply.placeholder = "Reply…";
      const actions = document.createElement("div");
      actions.className = "comment-actions";
      const replyBtn = document.createElement("button");
      replyBtn.type = "button";
      replyBtn.className = "comment-primary";
      replyBtn.textContent = "Reply";
      replyBtn.addEventListener("click", () => {
        const text = reply.value.trim();
        if (!text || currentUser === null) return;
        commentMutate(() => addReply(localDoc, {parentId: root.id, authorId: currentUser!.id, body: text}));
        rerenderOpenThread();
      });
      const resolveBtn = document.createElement("button");
      resolveBtn.type = "button";
      resolveBtn.className = "comment-link";
      resolveBtn.textContent = "Resolve";
      resolveBtn.addEventListener("click", () => { commentMutate(() => setResolved(localDoc, root.id, true)); rerenderOpenThread(); });
      actions.append(replyBtn, resolveBtn);
      thread.append(reply, actions);
    }
    panel.appendChild(thread);
  }

  // Add-another-comment on this same line.
  if (canEdit) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "comment-link comment-add-another";
    add.textContent = "+ Add a comment on this line";
    add.addEventListener("click", () => openComposerPopover(line, anchorEl, view));
    panel.appendChild(add);
  }

  showPopover(panel, anchorEl);
}

// The composer for a NEW root comment on a line. charIndex is the line's start.
function openComposerPopover(line: number, anchorEl: HTMLElement, view: EditorView) {
  openThreadContext = undefined;
  const panel = document.createElement("div");
  const header = document.createElement("div");
  header.className = "comment-popover-header";
  header.textContent = `Comment on line ${line}`;
  const input = document.createElement("textarea");
  input.className = "comment-input";
  input.rows = 3;
  input.placeholder = "Write a comment…";
  const actions = document.createElement("div");
  actions.className = "comment-actions";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "comment-primary";
  submit.textContent = "Comment";
  submit.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text || currentUser === null) return;
    const charIndex = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
    commentMutate(() => addRootComment(localDoc, {charIndex, authorId: currentUser!.id, body: text}));
    closeCommentPopover();
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "comment-link";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeCommentPopover());
  actions.append(submit, cancel);
  panel.append(header, input, actions);
  showPopover(panel, anchorEl);
  setTimeout(() => input.focus(), 0);
}

// --- Comments panel (step 5): all threads + jump-to-line + detached section ---
let showResolvedComments = false;

// Scroll the editor to a 1-based line and place the cursor there.
function jumpToLine(line: number) {
  if (!editor) return;
  const target = Math.min(Math.max(1, line), editor.state.doc.lines);
  const pos = editor.state.doc.line(target).from;
  editor.dispatch({selection: {anchor: pos}, scrollIntoView: true});
  editor.focus();
}

// Render one root thread as a panel card (root body + reply count + status), clickable
// to jump to its line (live roots) and open the thread popover.
function renderPanelThread(root: ResolvedComment, replyCount: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "comments-panel-item";
  if (root.resolved) card.classList.add("resolved");
  if (root.line === null) card.classList.add("detached");

  const meta = document.createElement("div");
  meta.className = "comments-panel-meta";
  const where = root.line === null ? "detached" : `line ${root.line}`;
  const status = root.resolved ? " · resolved" : "";
  meta.textContent = `${where} · ${authorName(root.authorId)}${status}`;
  const body = document.createElement("div");
  body.className = "comments-panel-body";
  body.textContent = root.body;
  card.append(meta, body);
  if (replyCount > 0) {
    const replies = document.createElement("div");
    replies.className = "comments-panel-replies";
    replies.textContent = replyCount === 1 ? "1 reply" : `${replyCount} replies`;
    card.appendChild(replies);
  }
  // Live roots jump to their line and open the thread; detached ones can only be read
  // here (no line to anchor a popover to) — offer unresolve/reopen for resolved ones.
  if (root.line !== null && !root.resolved) {
    card.classList.add("clickable");
    card.addEventListener("click", () => {
      jumpToLine(root.line!);
      const marker = document.querySelector<HTMLElement>(".cm-comment-gutter-marker");
      openThreadPopover(root.line!, marker ?? card, editor!);
    });
  }
  if (canEdit && root.resolved) {
    const reopen = document.createElement("button");
    reopen.type = "button";
    reopen.className = "comment-link";
    reopen.textContent = "Reopen";
    reopen.addEventListener("click", () => { commentMutate(() => setResolved(localDoc, root.id, false)); renderCommentsPanel(); });
    card.appendChild(reopen);
  }
  return card;
}

function renderCommentsPanel() {
  const panel = document.getElementById("comments-panel");
  const list = document.getElementById("comments-list");
  if (!panel || !list || panel.hidden || !localDoc) return;
  const all = listComments(localDoc);
  const replyCounts = new Map<string, number>();
  for (const c of all) if (c.parentId !== null) replyCounts.set(c.parentId, (replyCounts.get(c.parentId) ?? 0) + 1);
  // Count a whole thread's replies (any depth) toward its root.
  const threadReplyCount = (rootId: string): number => {
    let total = 0;
    const walk = (id: string) => { for (const c of all) if (c.parentId === id) { total += 1; walk(c.id); } };
    walk(rootId);
    return total;
  };
  const roots = all.filter((c) => c.parentId === null);
  const open = roots.filter((r) => r.line !== null && !r.resolved).sort((a, b) => a.line! - b.line!);
  const detached = roots.filter((r) => r.line === null && !r.resolved);
  const resolved = roots.filter((r) => r.resolved);

  list.replaceChildren();
  const section = (title: string, items: ResolvedComment[]) => {
    if (items.length === 0) return;
    const heading = document.createElement("div");
    heading.className = "comments-panel-section";
    heading.textContent = title;
    list.appendChild(heading);
    for (const root of items) list.appendChild(renderPanelThread(root, threadReplyCount(root.id)));
  };
  section("Open", open);
  section("Detached", detached);
  if (showResolvedComments) section("Resolved", resolved);
  if (open.length === 0 && detached.length === 0 && (!showResolvedComments || resolved.length === 0)) {
    const empty = document.createElement("div");
    empty.className = "comment-empty";
    empty.textContent = "No comments yet.";
    list.appendChild(empty);
  }
}

// Hide the comments toggle and collapse the panel when no document is open.
function hideCommentsUi() {
  toggleCommentsPanel(false);
  ($("toggle-comments") as HTMLButtonElement).hidden = true;
}

function toggleCommentsPanel(force?: boolean) {
  const panel = document.getElementById("comments-panel");
  const button = document.getElementById("toggle-comments") as HTMLButtonElement | null;
  if (!panel || !button) return;
  panel.hidden = force !== undefined ? !force : !panel.hidden;
  button.setAttribute("aria-pressed", String(!panel.hidden));
  if (!panel.hidden) renderCommentsPanel();
}

// --- Activity / history panel (M12) --------------------------------------
type ActivityEntry = {id: string; revision: number; author: {id: number | null; kind: string | null; displayName: string}; metadata?: {reason?: string; sourceRun?: string}; createdAt: string};

const relativeTime = (iso: string) => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
};

function activityRow(entry: ActivityEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "comments-panel-item activity-item";
  row.dataset.activityId = entry.id;
  const meta = document.createElement("div");
  meta.className = "comments-panel-meta";
  meta.textContent = `${entry.author.displayName} · ${relativeTime(entry.createdAt)} · rev ${entry.revision}`;
  row.appendChild(meta);
  const reason = entry.metadata?.reason;
  if (reason) {
    const body = document.createElement("div");
    body.className = "comments-panel-body";
    body.textContent = entry.metadata?.sourceRun ? `${reason} (${entry.metadata.sourceRun})` : reason;
    row.appendChild(body);
  }
  return row;
}

async function renderActivityPanel() {
  const panel = document.getElementById("activity-panel");
  const list = document.getElementById("activity-list");
  if (!panel || !list || panel.hidden || activeDocumentId === undefined) return;
  try {
    const {entries} = await directoryRequest<{entries: ActivityEntry[]}>(`/api/documents/${activeDocumentId}/history?limit=50`);
    list.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "comment-empty";
      empty.textContent = "No activity yet.";
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) list.appendChild(activityRow(entry));
  } catch { /* best-effort; leave the panel as-is */ }
}

// Prepend a live entry when an edit broadcast arrives, so the open panel updates without
// a refetch. The broadcast carries the durable id, revision, and server-set author label.
function appendLiveActivity(message: {activityId?: string; revision?: number; agentId?: string}) {
  const panel = document.getElementById("activity-panel");
  const list = document.getElementById("activity-list");
  if (!panel || !list || panel.hidden || !message.activityId || message.revision === undefined) return;
  if (list.querySelector(`[data-activity-id="${message.activityId}"]`)) return; // de-dupe
  list.querySelector(".comment-empty")?.remove();
  list.prepend(activityRow({
    id: message.activityId,
    revision: message.revision,
    author: {id: null, kind: null, displayName: message.agentId ?? "someone"},
    createdAt: new Date().toISOString(),
  }));
}

function hideActivityUi() {
  toggleActivityPanel(false);
  ($("toggle-activity") as HTMLButtonElement).hidden = true;
}

// The user's own edits don't echo back over the WS, so appendLiveActivity (driven by
// collaborators' broadcasts) never sees them. Refetch the open panel shortly after local
// edits settle, debounced so a burst of typing triggers one refresh.
let activityRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleActivityRefresh() {
  const panel = document.getElementById("activity-panel");
  if (!panel || panel.hidden) return;
  if (activityRefreshTimer) clearTimeout(activityRefreshTimer);
  activityRefreshTimer = setTimeout(() => void renderActivityPanel(), 800);
}

function toggleActivityPanel(force?: boolean) {
  const panel = document.getElementById("activity-panel");
  const button = document.getElementById("toggle-activity") as HTMLButtonElement | null;
  if (!panel || !button) return;
  panel.hidden = force !== undefined ? !force : !panel.hidden;
  button.setAttribute("aria-pressed", String(!panel.hidden));
  if (!panel.hidden) void renderActivityPanel();
}

let uploadErrorTimer: ReturnType<typeof setTimeout> | undefined;
function showUploadError(message: string) {
  const element = $("error");
  element.textContent = message;
  element.hidden = false;
  if (uploadErrorTimer) clearTimeout(uploadErrorTimer);
  uploadErrorTimer = setTimeout(() => { element.hidden = true; element.textContent = ""; }, 5000);
}

// Upload raw image bytes and insert a Markdown image reference at the given range.
// Shared by the paste and drag-drop handlers. The insert flows through the normal
// CodeMirror -> Yjs binding, so it syncs and the preview renderer picks it up.
async function uploadAndInsert(view: EditorView, file: File, from: number, to = from) {
  try {
    if (activeDocumentId === undefined) throw new Error("Open a document before adding an image");
    const filename = file.name || "image";
    // Attach the image to the active document, then insert its reference.
    const response = await fetch(`/api/documents/${activeDocumentId}/files?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: {"content-type": file.type},
      body: file,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Image upload failed");
    const start = Math.min(from, view.state.doc.length);
    const end = Math.min(to, view.state.doc.length);
    const alt = filename.replace(/[\[\]\r\n]/g, "");
    const markdown = `![${alt}](${payload.url})`;
    view.dispatch({changes: {from: start, to: end, insert: markdown}, selection: {anchor: start + markdown.length}});
  } catch (error) {
    showUploadError(error instanceof Error ? error.message : "Image upload failed");
  }
}

const imageUploadHandlers = EditorView.domEventHandlers({
  paste(event, view) {
    const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.kind === "file" && entry.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return false; // Let normal text paste proceed.
    event.preventDefault();
    const selection = view.state.selection.main;
    void uploadAndInsert(view, file, selection.from, selection.to);
    return true;
  },
  dragover(event) {
    // Allow the drop only when the drag carries files, so text drags behave normally.
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return false;
    event.preventDefault();
    return true;
  },
  drop(event, view) {
    const images = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return false;
    event.preventDefault();
    // Insert at the drop location, falling back to the current selection.
    const pos = view.posAtCoords({x: event.clientX, y: event.clientY}) ?? view.state.selection.main.head;
    for (const file of images) void uploadAndInsert(view, file, pos);
    return true;
  },
});

function createEditor(value: string) {
  // Editing requires a signed-in human. Anonymous visitors get a read-only viewer
  // that still receives live updates; image paste/drop upload only when editable.
  const editingExtensions = canEdit
    ? [imageUploadHandlers]
    : [EditorView.editable.of(false), EditorState.readOnly.of(true)];
  editor = new EditorView({
    state: EditorState.create({
      doc: value,
      extensions: [mermaidGutter, commentGutter, basicSetup, markdown(), EditorView.lineWrapping, mermaidExtension, ...editingExtensions, EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingRemote) {
          const next = update.state.doc.toString();
          const previous = sharedText.toString();
          let start = 0;
          while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
          let oldEnd = previous.length;
          let nextEnd = next.length;
          while (oldEnd > start && nextEnd > start && previous[oldEnd - 1] === next[nextEnd - 1]) { oldEnd -= 1; nextEnd -= 1; }
          localDoc.transact(() => {
            if (oldEnd > start) sharedText.delete(start, oldEnd - start);
            if (nextEnd > start) sharedText.insert(start, next.slice(start, nextEnd));
          }, "codemirror-editor");
        }
        if (update.selectionSet || update.docChanged) sendCursor();
        // Comment line numbers shift with the text (from local typing or a remote
        // edit), but a text-only change fires no comments observer, so refresh here.
        if (update.docChanged) { renderCommentsPanel(); scheduleActivityRefresh(); }
      })],
    }),
    parent: editorHost,
  });
}

mermaid.initialize({startOnLoad: false, securityLevel: "strict", theme: "default"});

// Create a fresh local replica for a document, wiring its update stream to the
// outgoing queue. Called before loading each document (including on switch).
function initDoc() {
  localDoc = new Y.Doc();
  sharedText = localDoc.getText("content");
  localDoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    pendingUpdates.push(encode(update));
    flushUpdates();
  });
  // Mirror remote text changes into the editor as the edits they actually were.
  // Replacing the whole document instead would be far simpler, but CodeMirror maps
  // the selection through a transaction's changes — and there is no sensible
  // mapping through "delete everything", so the caret collapses to the top of the
  // document while the reader is typing. Positions in a Yjs delta are expressed
  // against the pre-change text, which is also what CodeMirror expects of the
  // entries in `changes`: retain advances, delete advances, insert does not.
  sharedText.observe((event, transaction) => {
    if (transaction.origin !== "remote" || !editor) return;
    const changes: {from: number; to?: number; insert?: string}[] = [];
    let position = 0;
    for (const op of event.delta) {
      if (typeof op.retain === "number") position += op.retain;
      else if (typeof op.insert === "string") changes.push({from: position, insert: op.insert});
      else if (typeof op.delete === "number") {
        changes.push({from: position, to: position + op.delete});
        position += op.delete;
      }
    }
    if (changes.length === 0) return;
    applyingRemote = true;
    // No scrollIntoView: a remote edit must not yank the reader's viewport either.
    editor.dispatch({changes});
    applyingRemote = false;
  });

  // A comment change (add/resolve/edit) may not touch the text, so it triggers no
  // CodeMirror docChanged. Nudge the editor to recompute the comment gutter. Guarded
  // because the initial state applies before the editor exists (loadState builds it
  // after). observeDeep also catches nested Y.Map edits (resolve, body).
  commentsType(localDoc).observeDeep(() => {
    editor?.dispatch({effects: refreshComments.of()});
    rerenderOpenThread(); // keep an open thread popover in sync with remote comment changes
    renderCommentsPanel(); // and the panel, if it's open
  });
}

// Load a document's state into the (freshly initialized) local replica and build
// the editor. `id` undefined uses the legacy alias, which resolves to the default
// document and reports its id back. Returns false if the document is not
// accessible (404), so the caller skips connecting.
async function loadState(id: number): Promise<boolean> {
  const response = await fetch(`/api/documents/${id}/state`);
  if (response.status === 404) {
    showDocumentNotFound();
    return false;
  }
  if (!response.ok) throw new Error("Could not read the document");
  const state = await response.json();
  activeDocumentId = state.documentId;
  setDocumentTitle(state.name ?? "Untitled document");
  highlightActiveDocument();
  Y.applyUpdate(localDoc, decode(state.update), "remote");
  // Editability now reflects the server's per-document permission, not just being
  // signed in: a viewer gets a read-only editor on someone else's document.
  canEdit = !!state.canEdit;
  canManageActive = !!state.canManage;
  updateShareAffordance();
  setEditModeLabel(canEdit);
  createEditor(sharedText.toString());
  ($("toggle-comments") as HTMLButtonElement).hidden = false; // comments are readable by viewers too
  ($("toggle-activity") as HTMLButtonElement).hidden = false;
  renderCommentsPanel();
  void renderActivityPanel();
  renderMetadata(state);
  return true;
}

// Whether the current user can manage sharing on the active document (owner/admin).
let canManageActive = false;

function updateShareAffordance() {
  ($("share-document") as HTMLButtonElement).hidden = !canManageActive;
}

function setEditModeLabel(canEditNow: boolean) {
  const el = $("edit-mode");
  el.textContent = canEditNow
    ? `Editing as ${currentUser?.name ?? ""}`
    : currentUser
      ? "Read-only (no edit access)"
      : "Read-only — sign in to edit";
  el.classList.toggle("read-only", !canEditNow);
}

function setDocumentTitle(name: string) {
  $("document-title").textContent = name;
  document.title = name ? `${name} — AI Collaborative Editor` : "AI Collaborative Editor";
}

function showDocumentNotFound() {
  activeDocumentId = undefined;
  canManageActive = false;
  updateShareAffordance();
  hideCommentsUi();
  hideActivityUi();
  setDocumentTitle("Document not found");
  const note = document.createElement("p");
  note.className = "directory-status directory-error";
  note.textContent = "This document does not exist, or you do not have access to it.";
  editorHost.replaceChildren(note);
  renderMetadata({});
}

// Mark the Explorer row of the active document (when the tree is loaded).
function highlightActiveDocument() {
  for (const row of document.querySelectorAll<HTMLElement>(".document-row")) {
    row.classList.toggle("active", Number(row.dataset.documentId) === activeDocumentId);
  }
}

function documentIdFromPath(): number | undefined {
  const match = /^\/documents\/(\d+)/.exec(location.pathname);
  return match ? Number(match[1]) : undefined;
}

// Each editing session (one document + one socket) gets a generation token so that
// events from a socket we've since switched away from are ignored.
let sessionGeneration = 0;

// Tear down the current session and bring up `id`. With no id (the "/" home URL, or
// after deleting the open document) it shows the welcome/empty state instead of
// opening anything — there is no default document. Teardown-then-rebuild is what
// keeps two documents from bleeding into each other.
async function activateDocument(id: number | undefined) {
  const generation = ++sessionGeneration;
  closeCommentPopover();
  openThreadContext = undefined;
  if (socket) { socket.close(); socket = undefined; }
  if (editor) { editor.destroy(); editor = undefined; }
  editorHost.replaceChildren();
  cursors.clear();
  pendingUpdates.length = 0;
  if (id === undefined) { showWelcome(); return; }
  activeDocumentId = id; // eager: a stale socket won't reconnect to us
  initDoc();
  const ok = await loadState(id);
  if (ok && activeDocumentId !== undefined && generation === sessionGeneration) connect(activeDocumentId, generation);
}

// The empty state a signed-in user sees at "/" with no document open. There is no
// auto-created document; the first one is created explicitly (and owned by them).
function showWelcome() {
  activeDocumentId = undefined;
  canManageActive = false;
  updateShareAffordance();
  hideCommentsUi();
  hideActivityUi();
  setDocumentTitle("Welcome");
  const panel = document.createElement("div");
  panel.className = "welcome-message";
  const heading = document.createElement("h3");
  heading.textContent = "Welcome";
  const intro = document.createElement("p");
  intro.textContent = "No document is open. Documents you create are private to you — you decide who else can read or edit each one.";
  const how = document.createElement("p");
  how.textContent = "To create one, open the Explorer (the ▱ icon on the left), right-click a folder, and choose “New document” — or:";
  const create = document.createElement("button");
  create.type = "button";
  create.className = "primary-action";
  create.textContent = "New document";
  create.addEventListener("click", () => void createDocumentInRoot());
  panel.append(heading, intro, how, create);
  editorHost.replaceChildren(panel);
  renderMetadata({});
  setEditModeLabel(false);
}

// Convenience: create a document in the Root folder and open it.
async function createDocumentInRoot() {
  const name = await requestName("New document", "Enter a name");
  if (!name?.trim()) return;
  try {
    const root = (await directoryRequest<{folders: Folder[]}>("/api/folders")).folders[0];
    const created = await directoryRequest<{id: number}>(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: name.trim()}),
    });
    if (!$("directory-sidebar").hidden && currentUser) await loadDirectory();
    openDocument(created.id);
  } catch (error) {
    $("error").textContent = error instanceof Error ? error.message : "Could not create document";
    $("error").hidden = false;
  }
}

// Open a document from the UI: push a shareable /documents/:id URL, then activate.
function openDocument(id: number, {push = true}: {push?: boolean} = {}) {
  if (push && id !== activeDocumentId) history.pushState({documentId: id}, "", `/documents/${id}`);
  void activateDocument(id).catch((error: Error) => {
    $("error").textContent = error.message;
    $("error").hidden = false;
  });
}

// Back/forward navigation between documents (no new history entry).
window.addEventListener("popstate", () => {
  if (!currentUser) return;
  void activateDocument(documentIdFromPath()).catch(() => undefined);
});

function applyRemoteUpdate(update: Uint8Array) {
  // Applying to the replica is all this does; the sharedText observer installed in
  // initDoc turns the resulting delta into precise editor changes.
  Y.applyUpdate(localDoc, update, "remote");
}

function connect(id: number, generation: number) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws?doc=${id}`);
  socket.addEventListener("open", () => {
    if (generation !== sessionGeneration) return;
    $("connection").textContent = "Live";
    $("connection").className = "status live";
    flushUpdates();
    sendCursor();
  });
  socket.addEventListener("close", () => {
    if (generation !== sessionGeneration) return; // we switched documents; don't reconnect
    $("connection").textContent = "Disconnected";
    $("connection").className = "status offline";
    setTimeout(() => { if (generation === sessionGeneration) connect(id, generation); }, 2000);
  });
  socket.addEventListener("message", ({data}) => {
    if (generation !== sessionGeneration) return; // event from a document we've left
    const message = JSON.parse(data);
    if (message.type === "initial_state") {
      applyingRemote = true;
      applyRemoteUpdate(decode(message.update));
      applyingRemote = false;
      for (const cursor of message.cursors ?? []) cursors.set(cursor.agentId, cursor);
      renderMetadata(message);
    } else if (message.type === "document_update" && message.agentId !== clientId) {
      applyRemoteUpdate(decode(message.update));
      renderMetadata(message);
      appendLiveActivity(message);
    } else if (message.type === "cursor_update") {
      cursors.set(message.cursor.agentId, message.cursor);
      renderMetadata({});
    } else if (message.type === "cursors") {
      cursors.clear();
      for (const cursor of message.cursors) cursors.set(cursor.agentId, cursor);
      renderMetadata({});
    }
  });
}

// Resolve sign-in state first. Only signed-in users open documents; anonymous
// visitors see the "Please sign in" screen (rendered by refreshAuth). The document
// to open comes from the URL (/documents/:id); "/" shows the welcome/empty state.
refreshAuth()
  .then(async () => {
    if (!currentUser) return;
    await activateDocument(documentIdFromPath());
  })
  .catch((error: Error) => {
    $("error").textContent = error.message;
    $("error").hidden = false;
  });
