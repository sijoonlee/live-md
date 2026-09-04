import {expect, test} from "@playwright/test";
import * as Y from "yjs";

// M11 leftover: update dedup is backed by the persisted update row, so a retried
// requestId returns the original response instead of applying the update twice.

const insertUpdate = (value: string) => {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
};

test("a retried requestId returns the same revision and applies the update once", async ({page}) => {
  await page.goto("/");

  const agentName = `idem-bot-${Date.now()}`;
  const docId = await page.evaluate(async (name) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    const doc = await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: `idem-${name}.md`}),
    })).json();
    return doc.id as number;
  }, agentName);

  const auth = {"x-agent-id": agentName, "content-type": "application/json"};
  const update = insertUpdate("hello once");
  const body = {requestId: `req-${Date.now()}`, update};

  // First submission applies the update (202) at some revision.
  const first = await page.request.post(`/api/documents/${docId}/updates`, {headers: auth, data: body});
  expect(first.status()).toBe(202);
  const firstRevision = (await first.json()).revision as number;

  // Retry with the SAME requestId: deduped — same revision, not re-applied.
  const retry = await page.request.post(`/api/documents/${docId}/updates`, {headers: auth, data: body});
  const retryRevision = (await retry.json()).revision as number;
  expect(retryRevision).toBe(firstRevision);

  // A DIFFERENT requestId with the same bytes is a genuine new submission → new revision.
  const third = await page.request.post(`/api/documents/${docId}/updates`, {
    headers: auth, data: {requestId: `other-${Date.now()}`, update},
  });
  expect(third.status()).toBe(202);
  expect((await third.json()).revision as number).toBeGreaterThan(firstRevision);

  // The text reflects a single application of the bytes (Yjs merge is idempotent too,
  // but this confirms nothing doubled).
  const state = await (await page.request.get(`/api/documents/${docId}/state`)).json();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(state.update, "base64")));
  expect(doc.getText("content").toString()).toBe("hello once");
});
