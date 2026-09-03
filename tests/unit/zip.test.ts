import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {crc32, createZip, readZip} from "../../src/zip.js";

test("crc32 matches known IEEE test vectors", () => {
  assert.equal(crc32(Buffer.from("")), 0x00000000);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926); // canonical CRC-32 check value
  assert.equal(crc32(Buffer.from("The quick brown fox jumps over the lazy dog")), 0x414fa339);
});

test("createZip/readZip round-trips entries, including binary bytes", () => {
  const entries = [
    {name: "doc.md", bytes: Buffer.from("# Title\n\nbody")},
    {name: "assets/report.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10])},
    {name: "assets/emoji-😀.txt", bytes: Buffer.from("unicode name")},
  ];
  const read = readZip(createZip(entries));
  assert.equal(read.length, 3);
  for (let i = 0; i < entries.length; i += 1) {
    assert.equal(read[i].name, entries[i].name);
    assert.deepEqual(read[i].bytes, new Uint8Array(entries[i].bytes));
  }
});

test("readZip rejects a corrupt archive", () => {
  assert.throws(() => readZip(new Uint8Array([1, 2, 3, 4])), /no end-of-central-directory/);
});

test("an empty zip is valid and reads back as no entries", () => {
  assert.deepEqual(readZip(createZip([])), []);
});

// The real proof the container is well-formed: a standard `unzip` accepts it.
test("the archive unzips with the system unzip tool", (t) => {
  let unzip: string;
  try {
    unzip = execFileSync("which", ["unzip"]).toString().trim();
  } catch {
    t.skip("unzip not available");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  try {
    const zip = createZip([
      {name: "hello.md", bytes: Buffer.from("hello world")},
      {name: "assets/data.bin", bytes: new Uint8Array([0, 1, 2, 3, 250])},
    ]);
    const zipPath = join(dir, "bundle.zip");
    writeFileSync(zipPath, zip);
    execFileSync(unzip, ["-o", zipPath, "-d", dir]);
    assert.equal(readFileSync(join(dir, "hello.md"), "utf8"), "hello world");
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, "assets/data.bin"))), new Uint8Array([0, 1, 2, 3, 250]));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
