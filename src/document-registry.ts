import {database} from "./db.js";
import {createPersistence} from "./persistence.js";
import {createLiveDocument, type LiveDocument} from "./document.js";

// Owns the live document instances, one per directory document id. A document is
// hydrated from persistence on first access and cached; idle documents are evicted
// so memory stays bounded no matter how many documents exist. Each document gets
// its own persistence stream keyed by the document id (as a string), so the
// per-document snapshot/compaction (M10) applies independently.

const IDLE_EVICT_MS = 5 * 60_000;

type Entry = {doc: LiveDocument; lastAccess: number};
const live = new Map<number, Entry>();

// Get (hydrating on first use) the live document for an id. Touches the access
// time so the eviction sweep keeps recently-used documents resident.
export const getLiveDocument = (id: number): LiveDocument => {
  let entry = live.get(id);
  if (!entry) {
    entry = {doc: createLiveDocument(createPersistence(database, String(id))), lastAccess: Date.now()};
    live.set(id, entry);
  }
  entry.lastAccess = Date.now();
  return entry.doc;
};

// The ids currently resident in memory (e.g. for the periodic cursor sweep, which
// only needs to touch documents that actually have state loaded).
export const liveDocumentIds = (): number[] => [...live.keys()];

// Snapshot + compact every resident document. Used by the periodic timer and on
// shutdown so no pending updates are lost.
export const snapshotAll = () => {
  for (const [id, entry] of live) {
    try {
      entry.doc.snapshotAndCompact();
    } catch (error) {
      console.warn(`snapshot failed for document ${id}`, error);
    }
  }
};

// Evict documents idle past the threshold, flushing a final snapshot first. The
// `isActive` predicate (supplied by the server, which tracks WebSocket rooms)
// keeps a document resident while any client is connected, so an open editor is
// never evicted out from under live edits.
export const evictIdle = (isActive: (id: number) => boolean, now = Date.now()) => {
  for (const [id, entry] of live) {
    if (now - entry.lastAccess <= IDLE_EVICT_MS || isActive(id)) continue;
    try {
      entry.doc.snapshotAndCompact();
    } catch (error) {
      console.warn(`snapshot-on-evict failed for document ${id}`, error);
    }
    live.delete(id);
  }
};
