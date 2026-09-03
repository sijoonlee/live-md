import assert from "node:assert/strict";
import {test} from "node:test";
import {findReferencedFileIds, rewriteAssetsToReferences, rewriteReferencesToAssets} from "../../src/markdown-assets.js";

test("findReferencedFileIds collects distinct ids from files and images refs", () => {
  const text = "![a](/api/files/7) and [b](/api/images/9) and again ![c](/api/files/7)";
  assert.deepEqual(findReferencedFileIds(text).sort((a, b) => a - b), [7, 9]);
});

test("external absolute URLs are not treated as references", () => {
  const text = "![x](https://cdn.example.com/api/files/7) and [y](http://h/api/images/3)";
  assert.deepEqual(findReferencedFileIds(text), []);
});

test("rewriteReferencesToAssets rewrites known ids and leaves unknown/broken/external alone", () => {
  const names = new Map([[7, "diagram.png"], [9, "report.pdf"]]);
  const text = [
    "![d](/api/files/7)",            // known -> assets/diagram.png
    "[r](/api/images/9)",            // known (image alias) -> assets/report.pdf
    "[gone](/api/files/42)",         // unknown/broken -> unchanged
    "![ext](https://x/api/files/7)", // external -> unchanged
  ].join("\n");
  const out = rewriteReferencesToAssets(text, (id) => {
    const name = names.get(id);
    return name ? `assets/${name}` : null;
  });
  assert.match(out, /!\[d\]\(assets\/diagram\.png\)/);
  assert.match(out, /\[r\]\(assets\/report\.pdf\)/);
  assert.match(out, /\[gone\]\(\/api\/files\/42\)/);
  assert.match(out, /!\[ext\]\(https:\/\/x\/api\/files\/7\)/);
});

test("rewriteAssetsToReferences is the inverse: assets/<name> -> /api/files/:id", () => {
  const ids = new Map([["diagram.png", 12], ["report.pdf", 13]]);
  const text = "![d](assets/diagram.png)\n[r](assets/report.pdf)\n[missing](assets/nope.txt)";
  const out = rewriteAssetsToReferences(text, (name) => {
    const id = ids.get(name);
    return id ? `/api/files/${id}` : null;
  });
  assert.match(out, /!\[d\]\(\/api\/files\/12\)/);
  assert.match(out, /\[r\]\(\/api\/files\/13\)/);
  assert.match(out, /\[missing\]\(assets\/nope\.txt\)/); // not in the bundle -> unchanged
});

test("export then import round-trips the same URLs", () => {
  const original = "![d](/api/files/7) plus [r](/api/images/9)";
  const filenames = new Map([[7, "diagram.png"], [9, "report.pdf"]]);
  const exported = rewriteReferencesToAssets(original, (id) => `assets/${filenames.get(id)}`);
  // On import the same files come back as (possibly new) ids.
  const newIds = new Map([["diagram.png", 100], ["report.pdf", 101]]);
  const reimported = rewriteAssetsToReferences(exported, (name) => `/api/files/${newIds.get(name)}`);
  assert.equal(reimported, "![d](/api/files/100) plus [r](/api/files/101)");
});
