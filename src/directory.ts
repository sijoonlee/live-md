import {database} from "./db.js";

database.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    parent_folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(parent_folder_id, name)
  );
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    yjs_snapshot_blob BLOB,
    updated_at TEXT NOT NULL,
    UNIQUE(folder_id, name)
  );
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_shares (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    principal_id INTEGER NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('editor', 'viewer')),
    PRIMARY KEY (document_id, principal_id)
  );
`);

// Ownership anchor for the authorization model (M14/M21 phase 3). Added by
// migration so existing prototype databases upgrade in place. Nullable for now:
// the migrated default document and any pre-ownership rows have no owner, and the
// phase-1 access check ignores it. Phase 3 tightens this to NOT NULL + can().
// (A plain column, not a declared FK: `principals` is created by another module
// that may load after this one, and FK enforcement is off. Phase 3 formalizes it.)
const documentColumns = database.prepare("PRAGMA table_info(documents)").all() as {name: string}[];
if (!documentColumns.some((column) => column.name === "owner_id")) {
  database.exec("ALTER TABLE documents ADD COLUMN owner_id INTEGER");
}

const now = () => new Date().toISOString();
const existingRoot = database.prepare("SELECT id FROM folders WHERE parent_folder_id IS NULL AND name = 'Root'").get() as {id: number} | undefined;
if (!existingRoot) database.prepare("INSERT INTO folders (parent_folder_id, name, created_at) VALUES (NULL, 'Root', ?)").run(now());
const rootId = (database.prepare("SELECT id FROM folders WHERE parent_folder_id IS NULL AND name = 'Root'").get() as {id: number}).id;
// Older prototype data could contain folders beside Root. Keep them, but place
// them under the single root so the directory has one top-level entry.
database.prepare("UPDATE folders SET parent_folder_id = ? WHERE parent_folder_id IS NULL AND id <> ?").run(rootId, rootId);

export type Folder = {id: number; parentFolderId: number | null; name: string; createdAt: string};
export type DirectoryDocument = {id: number; folderId: number; name: string; ownerId: number | null; createdAt: string; updatedAt: string};

const folder = (row: Record<string, unknown>): Folder => ({id: row.id as number, parentFolderId: row.parent_folder_id as number | null, name: row.name as string, createdAt: row.created_at as string});
const document = (row: Record<string, unknown>): DirectoryDocument => ({id: row.id as number, folderId: row.folder_id as number, name: row.name as string, ownerId: (row.owner_id as number | null) ?? null, createdAt: row.created_at as string, updatedAt: row.updated_at as string});

export const listFolders = (parentFolderId: number | null) => {
  const rows = (parentFolderId === null
    ? database.prepare("SELECT * FROM folders WHERE id = ? ORDER BY name").all(rootId)
    : database.prepare("SELECT * FROM folders WHERE parent_folder_id = ? ORDER BY name").all(parentFolderId)) as Record<string, unknown>[];
  return rows.map(folder);
};

export const getFolder = (id: number) => {
  const row = database.prepare("SELECT * FROM folders WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? folder(row) : undefined;
};

export const createFolder = (name: string, parentFolderId: number | null) => {
  const result = database.prepare("INSERT INTO folders (parent_folder_id, name, created_at) VALUES (?, ?, ?)").run(parentFolderId ?? rootId, name, now());
  return getFolder(Number(result.lastInsertRowid));
};

export const renameFolder = (id: number, name: string) => {
  database.prepare("UPDATE folders SET name = ? WHERE id = ?").run(name, id);
  return getFolder(id);
};

const isDescendant = (candidateId: number, ancestorId: number) => {
  let current = candidateId;
  while (true) {
    const row = database.prepare("SELECT parent_folder_id FROM folders WHERE id = ?").get(current) as {parent_folder_id: number | null} | undefined;
    if (!row || row.parent_folder_id === null) return false;
    if (row.parent_folder_id === ancestorId) return true;
    current = row.parent_folder_id;
  }
};

export const moveFolder = (id: number, parentFolderId: number | null) => {
  if (id === rootId) throw new Error("root folder cannot be moved");
  if (parentFolderId === id || (parentFolderId !== null && isDescendant(parentFolderId, id))) throw new Error("folder cannot be moved into itself or a descendant");
  database.prepare("UPDATE folders SET parent_folder_id = ? WHERE id = ?").run(parentFolderId ?? rootId, id);
  return getFolder(id);
};

export const deleteFolder = (id: number) => {
  if (id === rootId) throw new Error("root folder cannot be deleted");
  database.prepare("DELETE FROM folders WHERE id = ?").run(id);
};

export const listDocuments = (folderId: number) => {
  const rows = database.prepare("SELECT * FROM documents WHERE folder_id = ? ORDER BY name").all(folderId) as Record<string, unknown>[];
  return rows.map(document);
};

export const getDocument = (id: number) => {
  const row = database.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? document(row) : undefined;
};

export const createDocument = (folderId: number, name: string, ownerId: number | null = null) => {
  const timestamp = now();
  const result = database.prepare("INSERT INTO documents (folder_id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(folderId, name, ownerId, timestamp, timestamp);
  return getDocument(Number(result.lastInsertRowid));
};

export const renameDocument = (id: number, name: string) => {
  database.prepare("UPDATE documents SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id);
  return getDocument(id);
};

export const moveDocument = (id: number, folderId: number) => {
  database.prepare("UPDATE documents SET folder_id = ?, updated_at = ? WHERE id = ?").run(folderId, now(), id);
  return getDocument(id);
};

export const deleteDocument = (id: number) => {
  database.prepare("DELETE FROM documents WHERE id = ?").run(id);
};

// (No default document. The app deliberately starts with zero documents — the first
// is one a signed-in user explicitly creates, and therefore owns. There is no
// auto-created, ownerless, world-writable document.)

// --- Per-document sharing (M21 phase 3) -----------------------------------
// Each row grants one principal (human or agent) a level on one document. The
// owner is NOT stored here (it lives on documents.owner_id); this table is only the
// editor/viewer lists. Deleting a document cascades its shares away.
export type ShareLevel = "editor" | "viewer";
export type DocumentShare = {principalId: number; level: ShareLevel};

export const getShareLevel = (documentId: number, principalId: number): ShareLevel | undefined => {
  const row = database.prepare("SELECT level FROM document_shares WHERE document_id = ? AND principal_id = ?").get(documentId, principalId) as {level: string} | undefined;
  return row ? (row.level as ShareLevel) : undefined;
};

export const listShares = (documentId: number): DocumentShare[] => {
  const rows = database.prepare("SELECT principal_id, level FROM document_shares WHERE document_id = ? ORDER BY principal_id").all(documentId) as {principal_id: number; level: string}[];
  return rows.map((row) => ({principalId: row.principal_id, level: row.level as ShareLevel}));
};

export const setShare = (documentId: number, principalId: number, level: ShareLevel): void => {
  database.prepare(
    "INSERT INTO document_shares (document_id, principal_id, level) VALUES (?, ?, ?) ON CONFLICT(document_id, principal_id) DO UPDATE SET level = excluded.level",
  ).run(documentId, principalId, level);
};

export const removeShare = (documentId: number, principalId: number): boolean => {
  const result = database.prepare("DELETE FROM document_shares WHERE document_id = ? AND principal_id = ?").run(documentId, principalId);
  return result.changes > 0;
};
