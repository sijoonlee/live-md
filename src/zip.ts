// A tiny, dependency-free ZIP reader/writer for M19 export/import bundles. Entries are
// stored **uncompressed** (method 0, "store"): the export payload is already-compressed
// images/PDFs plus tiny Markdown, so DEFLATE would buy almost nothing, and a store-only
// container is a handful of buffer writes. Server-side only, so it uses Node Buffers.
//
// Layout (little-endian throughout):
//   per entry:  [local file header][name][raw bytes]
//   then:       [central directory record per entry] [end-of-central-directory]
// The one non-trivial detail is the CRC-32 each entry carries so unzip tools can verify
// integrity. No zip64, no data descriptors — files here are far under 4 GiB.

export type ZipEntry = {name: string; bytes: Uint8Array};

const LOCAL_SIG = 0x04034b50; // PK\x03\x04
const CENTRAL_SIG = 0x02014b50; // PK\x01\x02
const EOCD_SIG = 0x06054b50; // PK\x05\x06
const UTF8_FLAG = 0x0800; // general-purpose bit 11: filenames are UTF-8

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = (crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.bytes);
    const crc = crc32(entry.bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(UTF8_FLAG, 8);
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length
  return new Uint8Array(Buffer.concat([...parts, centralBuf, eocd]));
}

// Read a store-only zip back into entries. Rejects compressed entries (method != 0),
// which our writer never produces. Used by Markdown import (M19 step 5).
export function readZip(zip: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(zip);
  let eocd = -1;
  // Scan backward for the end-of-central-directory signature (past any trailing comment).
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CENTRAL_SIG) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const crcExpected = buf.readUInt32LE(ptr + 16);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    if (method !== 0) throw new Error(`unsupported compression method ${method} (store-only reader)`);

    // The local header repeats the name/extra lengths; the data begins after them.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error("corrupt local header");
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const bytes = new Uint8Array(buf.subarray(dataStart, dataStart + compSize));
    if (crc32(bytes) !== crcExpected) throw new Error(`crc mismatch for "${name}"`);
    entries.push({name, bytes});
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
