// Shared Markdown asset-link rewriting for M19 export/import. Attachments are referenced
// from the document text as Markdown links/images pointing at `/api/files/:id` (or the
// legacy `/api/images/:id` alias). Export rewrites those to `assets/<filename>` for a
// portable bundle; import rewrites `assets/<filename>` back to `/api/files/:id`. Both
// directions share one scanning pass so they stay exact inverses.
//
// The lookbehind `(?<=\()` restricts matches to Markdown link/image syntax `](…)`, which
// is the only form the editor ever produces. That deliberately leaves **absolute** URLs
// alone: `(https://host/api/files/7)` has `t`/`m` before `/api`, not `(`, so it is not a
// relative reference and is passed through untouched (export decision: leave external
// links as-is).

export type AssetKind = "files" | "images";

// A relative attachment reference inside a Markdown link/image: `](/api/files/7)`.
const REF_URL = /(?<=\()\/api\/(files|images)\/(\d+)/g;
// A bundled asset path inside a Markdown link/image: `](assets/report.pdf)`.
const ASSET_PATH = /(?<=\()assets\/([^)]+)/g;

// The distinct attachment ids referenced by the text (either `/api/files` or `/api/images`).
export function findReferencedFileIds(text: string): number[] {
  const ids = new Set<number>();
  for (const match of text.matchAll(REF_URL)) ids.add(Number(match[2]));
  return [...ids];
}

// Export direction: rewrite each `/api/files|images/:id` reference. `replace` returns the
// replacement path (e.g. `assets/report.pdf`), or `null` to leave that reference unchanged
// (e.g. an id that is not one of this document's attachments, or a broken/removed file).
export function rewriteReferencesToAssets(
  text: string,
  replace: (id: number, kind: AssetKind) => string | null,
): string {
  return text.replace(REF_URL, (whole, kind: string, idStr: string) => {
    const out = replace(Number(idStr), kind as AssetKind);
    return out ?? whole;
  });
}

// Import direction: rewrite each `assets/<filename>` path. `replace` returns the
// replacement URL (e.g. `/api/files/12`), or `null` to leave it unchanged (an asset the
// bundle did not actually contain).
export function rewriteAssetsToReferences(
  text: string,
  replace: (filename: string) => string | null,
): string {
  return text.replace(ASSET_PATH, (whole, filename: string) => {
    const out = replace(filename);
    return out ?? whole;
  });
}
