import {randomUUID} from "node:crypto";
import {database} from "./db.js";
// Importing directory for its side effects guarantees the `documents` table exists
// before this table's foreign key into it is created.
import "./directory.js";

// A durable, append-only activity log: one row per accepted update, for the
// authorship/history timeline (M12) and as the home of the server-minted, durable
// update id (M11). Deliberately SEPARATE from the M10 `document_updates` log, which is
// a compactable CRDT replay optimization (its rows are deleted on snapshot). This table
// is never compacted, so it is a stable record of what happened to a document.
//
// The `id` is the server-side update identifier: minted here (never from the client),
// stable, and independent of the client's optional idempotency `requestId`.

// Bound growth: keep at most this many activity rows per document (newest kept).
export const MAX_ACTIVITY_PER_DOCUMENT = 500;

database.exec(`
  CREATE TABLE IF NOT EXISTS document_activity (
    id            TEXT PRIMARY KEY,
    document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision      INTEGER NOT NULL,
    author_label  TEXT,
    metadata      TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_document_activity_doc ON document_activity(document_id, id);
`);

export type ActivityRecord = {
  id: string;
  documentId: number;
  revision: number;
  authorLabel: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

const insertActivity = database.prepare(
  "INSERT INTO document_activity (id, document_id, revision, author_label, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);
// Prune to the newest MAX_ACTIVITY_PER_DOCUMENT rows for a document. uuid v4 ids are
// not time-ordered, so rank by rowid (insertion order) rather than id.
const pruneActivity = database.prepare(
  `DELETE FROM document_activity WHERE document_id = ? AND rowid NOT IN (
     SELECT rowid FROM document_activity WHERE document_id = ? ORDER BY rowid DESC LIMIT ?
   )`,
);

const parseMetadata = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const toRecord = (row: Record<string, unknown>): ActivityRecord => ({
  id: row.id as string,
  documentId: row.document_id as number,
  revision: row.revision as number,
  authorLabel: (row.author_label as string | null) ?? null,
  metadata: parseMetadata(row.metadata),
  createdAt: row.created_at as string,
});

// Record one accepted update and return the minted, durable update id. The author
// label is set by the server from the request, not taken from the update body.
export const recordActivity = (entry: {
  documentId: number;
  revision: number;
  authorLabel?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}): string => {
  const id = randomUUID();
  insertActivity.run(
    id,
    entry.documentId,
    entry.revision,
    entry.authorLabel ?? null,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.createdAt ?? new Date().toISOString(),
  );
  pruneActivity.run(entry.documentId, entry.documentId, MAX_ACTIVITY_PER_DOCUMENT);
  return id;
};

// A newest-first page of a document's activity. `before` is the id of the last row of
// the previous page (cursor); rows are ordered by insertion (rowid) so paging is stable.
export const listActivity = (
  documentId: number,
  options: {limit?: number; before?: string} = {},
): ActivityRecord[] => {
  const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
  if (options.before) {
    const cursor = database.prepare("SELECT rowid FROM document_activity WHERE id = ? AND document_id = ?").get(options.before, documentId) as
      | {rowid: number}
      | undefined;
    if (!cursor) return [];
    const rows = database
      .prepare("SELECT * FROM document_activity WHERE document_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
      .all(documentId, cursor.rowid, limit) as Record<string, unknown>[];
    return rows.map(toRecord);
  }
  const rows = database
    .prepare("SELECT * FROM document_activity WHERE document_id = ? ORDER BY rowid DESC LIMIT ?")
    .all(documentId, limit) as Record<string, unknown>[];
  return rows.map(toRecord);
};

// Test/maintenance helper: total activity rows for a document.
export const countActivity = (documentId: number): number =>
  Number((database.prepare("SELECT COUNT(*) AS c FROM document_activity WHERE document_id = ?").get(documentId) as {c: number}).c);
