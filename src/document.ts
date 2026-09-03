import * as Y from "yjs";
import type {Persistence} from "./persistence.js";

// Limits protect the in-memory document and the update log from unbounded growth
// by untrusted agents. They are enforced in applyUpdate so both the HTTP and
// WebSocket paths are covered.
export const MAX_UPDATE_BYTES = 1_048_576; // 1 MiB per single update.
export const MAX_DOCUMENT_CHARS = 5_000_000; // ~5 MB of Markdown text.
export const MAX_UPDATE_HISTORY = 100; // In-memory recent-update metadata cap.
// Compact after this many appended updates so the log and startup replay stay
// bounded. A periodic timer in the server provides an additional time trigger.
export const SNAPSHOT_EVERY_UPDATES = 50;

export type AgentCursor = {
  agentId: string;
  label: string;
  anchor: number;
  head: number;
  color: string;
  lastSeenAt: string;
};

export type UpdateRecord = {
  revision: number;
  agentId: string;
  receivedAt: string;
  metadata?: Record<string, unknown>;
};

const colorPalette = ["#4f8cff", "#d85cff", "#00a878", "#f28f3b", "#e05263", "#7b61ff"];

// One live editable document: an in-memory Y.Doc plus its cursors and recent-update
// metadata, backed by a persistence stream. The server holds one of these per
// directory document (keyed by document id in the registry); nothing here is a
// singleton, so many documents coexist without cross-talk.
export const createLiveDocument = (persistence: Persistence) => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const cursors = new Map<string, AgentCursor>();
  const updates: UpdateRecord[] = [];
  let revision = 0;
  let updatedAt = new Date().toISOString();
  let lastUpdatedBy: string | undefined;
  let updatesSinceSnapshot = 0;

  // Rebuild the in-memory Y.Doc from the last snapshot plus any updates recorded
  // after it. Corrupt rows are skipped rather than aborting startup: Yjs merging is
  // idempotent, so a partial replay still yields a usable, self-consistent document.
  const hydrateFromPersistence = () => {
    const state = persistence.load();
    if (state.snapshot) {
      try {
        Y.applyUpdate(doc, state.snapshot);
        revision = state.snapshotRevision;
      } catch (error) {
        console.warn("failed to apply persisted snapshot; starting from updates", error);
      }
    }
    for (const entry of state.updates) {
      try {
        Y.applyUpdate(doc, entry.update);
        revision = Math.max(revision, entry.revision);
      } catch (error) {
        console.warn(`skipping corrupt persisted update at revision ${entry.revision}`, error);
      }
    }
    if (revision > 0) {
      updatedAt = new Date().toISOString();
      console.log(`restored document at revision ${revision} (${text.length} chars)`);
    }
  };

  hydrateFromPersistence();

  const getText = () => text.toString();
  const getRevision = () => revision;
  const getMetadata = () => ({revision, updatedAt, lastUpdatedBy});

  const encodeState = () => Y.encodeStateAsUpdate(doc);
  const encodeStateVector = () => Y.encodeStateVector(doc);
  const encodeMissingState = (stateVector: Uint8Array) => Y.encodeStateAsUpdate(doc, stateVector);

  const applyUpdate = (update: Uint8Array, agentId: string, metadata?: Record<string, unknown>, requestId?: string) => {
    if (update.byteLength > MAX_UPDATE_BYTES) {
      throw new Error(`update exceeds the ${MAX_UPDATE_BYTES}-byte limit`);
    }
    // Reject growth once the document is already at capacity. Combined with the
    // per-update byte limit this bounds the document without an expensive
    // apply-to-a-clone pre-check on every keystroke batch.
    if (text.length >= MAX_DOCUMENT_CHARS) {
      throw new Error(`document is at the ${MAX_DOCUMENT_CHARS}-character limit`);
    }
    Y.applyUpdate(doc, update);
    revision += 1;
    updatedAt = new Date().toISOString();
    lastUpdatedBy = agentId;
    updates.push({revision, agentId, receivedAt: updatedAt, metadata});
    if (updates.length > MAX_UPDATE_HISTORY) updates.shift();
    persistence.appendUpdate(revision, update, agentId, metadata, requestId);
    updatesSinceSnapshot += 1;
    if (updatesSinceSnapshot >= SNAPSHOT_EVERY_UPDATES) snapshotAndCompact();
    return revision;
  };

  // Persist the current document as a compacted snapshot and drop the update rows
  // it now covers. Safe to call at any time; the underlying write is transactional.
  const snapshotAndCompact = () => {
    persistence.writeSnapshot(Y.encodeStateAsUpdate(doc), revision);
    updatesSinceSnapshot = 0;
    return revision;
  };

  const getUpdates = () => [...updates];

  // Restart-durable idempotency: has an update with this requestId already been
  // accepted (and persisted)? Returns the original accept response fields, so a retry
  // gets the same answer without re-applying. Backed by the persisted update row.
  const findProcessedRequest = (requestId: string) => {
    const found = persistence.findByRequestId(requestId);
    return found ? {revision: found.revision, updatedAt: found.createdAt, lastUpdatedBy: found.agentId ?? undefined} : undefined;
  };

  const upsertCursor = (
    agentId: string,
    cursor: Pick<AgentCursor, "anchor" | "head"> & Partial<Pick<AgentCursor, "label">>,
  ) => {
    const existing = cursors.get(agentId);
    const color = existing?.color ?? colorPalette[cursors.size % colorPalette.length];
    const next: AgentCursor = {
      agentId,
      label: cursor.label?.trim() || existing?.label || agentId,
      anchor: Math.max(0, cursor.anchor),
      head: Math.max(0, cursor.head),
      color,
      lastSeenAt: new Date().toISOString(),
    };
    cursors.set(agentId, next);
    return next;
  };

  const getCursors = () => [...cursors.values()];

  const removeStaleCursors = (maxAgeMs = 60_000) => {
    const threshold = Date.now() - maxAgeMs;
    for (const [agentId, cursor] of cursors) {
      if (Date.parse(cursor.lastSeenAt) < threshold) cursors.delete(agentId);
    }
  };

  return {
    getText,
    getRevision,
    getMetadata,
    encodeState,
    encodeStateVector,
    encodeMissingState,
    applyUpdate,
    snapshotAndCompact,
    getUpdates,
    findProcessedRequest,
    upsertCursor,
    getCursors,
    removeStaleCursors,
  };
};

export type LiveDocument = ReturnType<typeof createLiveDocument>;
