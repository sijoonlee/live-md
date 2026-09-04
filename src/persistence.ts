import type {DatabaseSync} from "node:sqlite";
import {database} from "./db.js";

// Durable storage for a single document as a compacted Yjs snapshot plus an
// append-only log of later updates. Yjs merging never needs a database, but this
// lets the server recover the in-memory Y.Doc after a restart and keep agent
// history. The store is intentionally dumb: it reads and writes bytes and never
// touches a Y.Doc itself, so applying/merging stays entirely in document.ts.

export type PersistedUpdate = {
  revision: number;
  update: Uint8Array;
  agentId: string | null;
  metadata?: Record<string, unknown>;
};

export type PersistedState = {
  snapshot: Uint8Array | null;
  snapshotRevision: number;
  updates: PersistedUpdate[];
};

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("expected a BLOB value");
};

const parseMetadata = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

export const createPersistence = (db: DatabaseSync, documentKey = "prototype") => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_snapshots (
      document_key TEXT PRIMARY KEY,
      yjs_snapshot_blob BLOB NOT NULL,
      snapshot_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      update_blob BLOB NOT NULL,
      agent_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_updates_key_rev
      ON document_updates(document_key, revision);
  `);


  const snapshotRow = db.prepare(
    "SELECT yjs_snapshot_blob, snapshot_revision FROM document_snapshots WHERE document_key = ?",
  );
  // Only replay updates newer than the snapshot. Rows left behind by an
  // interrupted compaction have revision <= snapshotRevision and are skipped,
  // so a half-finished compaction never double-applies or corrupts state.
  const laterUpdatesRows = db.prepare(
    "SELECT revision, update_blob, agent_id, metadata FROM document_updates WHERE document_key = ? AND revision > ? ORDER BY revision, id",
  );
  const insertUpdate = db.prepare(
    "INSERT INTO document_updates (document_key, revision, update_blob, agent_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const upsertSnapshot = db.prepare(`
    INSERT INTO document_snapshots (document_key, yjs_snapshot_blob, snapshot_revision, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(document_key) DO UPDATE SET
      yjs_snapshot_blob = excluded.yjs_snapshot_blob,
      snapshot_revision = excluded.snapshot_revision,
      updated_at = excluded.updated_at
  `);
  const deleteCoveredUpdates = db.prepare(
    "DELETE FROM document_updates WHERE document_key = ? AND revision <= ?",
  );
  const countUpdatesRow = db.prepare(
    "SELECT COUNT(*) AS count FROM document_updates WHERE document_key = ?",
  );

  const load = (): PersistedState => {
    const snapshot = snapshotRow.get(documentKey) as
      | {yjs_snapshot_blob: unknown; snapshot_revision: number}
      | undefined;
    const snapshotRevision = snapshot?.snapshot_revision ?? 0;
    const rows = laterUpdatesRows.all(documentKey, snapshotRevision) as {
      revision: number;
      update_blob: unknown;
      agent_id: string | null;
      metadata: unknown;
    }[];
    return {
      snapshot: snapshot ? toBytes(snapshot.yjs_snapshot_blob) : null,
      snapshotRevision,
      updates: rows.map((row) => ({
        revision: row.revision,
        update: toBytes(row.update_blob),
        agentId: row.agent_id,
        metadata: parseMetadata(row.metadata),
      })),
    };
  };

  const appendUpdate = (
    revision: number,
    update: Uint8Array,
    agentId: string,
    metadata?: Record<string, unknown>,
    createdAt = new Date().toISOString(),
  ) => {
    insertUpdate.run(
      documentKey,
      revision,
      update,
      agentId,
      metadata ? JSON.stringify(metadata) : null,
      createdAt,
    );
  };

  // Write a fresh snapshot at `revision` and drop the update rows it now covers.
  // The two writes happen in one transaction so a crash leaves either the old
  // snapshot with the full log, or the new snapshot with the log trimmed — never
  // a new snapshot with un-trimmed rows that would replay on top of it.
  const writeSnapshot = (
    snapshot: Uint8Array,
    revision: number,
    updatedAt = new Date().toISOString(),
  ) => {
    db.exec("BEGIN");
    try {
      upsertSnapshot.run(documentKey, snapshot, revision, updatedAt);
      deleteCoveredUpdates.run(documentKey, revision);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const countUpdates = () => Number((countUpdatesRow.get(documentKey) as {count: number}).count);

  return {load, appendUpdate, writeSnapshot, countUpdates};
};

export type Persistence = ReturnType<typeof createPersistence>;

export const persistence = createPersistence(database);
