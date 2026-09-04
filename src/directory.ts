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
`);

// Databases from the multi-user build carry documents.owner_id and a
// document_shares table. Both are meaningless here and are simply ignored — dropping
// them would make the file unreadable by that build for no gain.

const now = () => new Date().toISOString();
const existingRoot = database.prepare("SELECT id FROM folders WHERE parent_folder_id IS NULL AND name = 'Root'").get() as {id: number} | undefined;
if (!existingRoot) database.prepare("INSERT INTO folders (parent_folder_id, name, created_at) VALUES (NULL, 'Root', ?)").run(now());
const rootId = (database.prepare("SELECT id FROM folders WHERE parent_folder_id IS NULL AND name = 'Root'").get() as {id: number}).id;
// Older prototype data could contain folders beside Root. Keep them, but place
// them under the single root so the directory has one top-level entry.
database.prepare("UPDATE folders SET parent_folder_id = ? WHERE parent_folder_id IS NULL AND id <> ?").run(rootId, rootId);

export type Folder = {id: number; parentFolderId: number | null; name: string; createdAt: string};
export type DirectoryDocument = {id: number; folderId: number; name: string; createdAt: string; updatedAt: string};

const folder = (row: Record<string, unknown>): Folder => ({id: row.id as number, parentFolderId: row.parent_folder_id as number | null, name: row.name as string, createdAt: row.created_at as string});
const document = (row: Record<string, unknown>): DirectoryDocument => ({id: row.id as number, folderId: row.folder_id as number, name: row.name as string, createdAt: row.created_at as string, updatedAt: row.updated_at as string});

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

export const createDocument = (folderId: number, name: string) => {
  const timestamp = now();
  const result = database.prepare("INSERT INTO documents (folder_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(folderId, name, timestamp, timestamp);
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
