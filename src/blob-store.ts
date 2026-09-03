import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {readdir, rm} from "node:fs/promises";
import path from "node:path";
import {dataDir} from "./db.js";

// Content-addressed blob store. Bytes live once at `data/blobs/<sha256>`, keyed by
// the SHA-256 of their content: identical uploads dedupe, and stored blobs are
// immutable so they can be served with a long cache lifetime. Callers reference a
// blob only by its checksum, never by a filesystem path.
const blobsDir = path.join(dataDir, "blobs");
mkdirSync(blobsDir, {recursive: true});

const isChecksum = (value: string) => /^[a-f0-9]{64}$/.test(value);
const blobPath = (checksum: string) => path.join(blobsDir, checksum);

export const writeBlob = (checksum: string, bytes: Uint8Array) => {
  writeFileSync(blobPath(checksum), bytes);
};

export const readBlob = (checksum: string): Uint8Array | undefined => {
  if (!isChecksum(checksum)) return undefined;
  try {
    return readFileSync(blobPath(checksum));
  } catch {
    return undefined;
  }
};

export const blobExists = (checksum: string) => isChecksum(checksum) && existsSync(blobPath(checksum));

// Mark-and-sweep garbage collection: delete every blob whose checksum is not in
// `referenced`. Building that set from the database is the caller's job (it is the
// "mark" phase); this function only performs the "sweep" over the filesystem. It
// never inspects document text, so it cannot remove a blob a live document still
// points at as long as the file's row survives. Returns the checksums it removed.
export const sweepOrphanBlobs = async (referenced: Set<string>): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(blobsDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!isChecksum(entry) || referenced.has(entry)) continue;
    await rm(blobPath(entry), {force: true});
    removed.push(entry);
  }
  return removed;
};
