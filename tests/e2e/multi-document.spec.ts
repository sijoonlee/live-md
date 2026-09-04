import {expect, test} from "@playwright/test";
import * as Y from "yjs";

// A base64 Yjs update that inserts `value` at the start of an empty document.
const insertUpdate = (value: string) => {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
};

test("id-keyed documents hold independent content", async ({page, request}) => {
  await page.goto("/"); // establishes the signed-in session via storageState

  const root = (await (await request.get("/api/folders")).json()).folders[0];
  const create = async (name: string) =>
    (await request.post(`/api/folders/${root.id}/documents`, {data: {name}})).json();
  const suffix = Date.now();
  const docA = await create(`iso-a-${suffix}.md`);
  const docB = await create(`iso-b-${suffix}.md`);

  // Writes name their agent for the history log; nothing authenticates them.
  const agentName = `iso-agent-${suffix}`;
  const auth = {"x-agent-id": agentName};

  // Write only to document A.
  const write = await request.post(`/api/documents/${docA.id}/updates`, {
    headers: auth,
    data: {requestId: `iso-${suffix}`, update: insertUpdate("only in A")},
  });
  expect(write.status()).toBe(202);

  const textViaToken = async (id: number) => {
    const state = await (await request.get(`/api/documents/${id}/state`, {headers: auth})).json();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(state.update, "base64")));
    return doc.getText("content").toString();
  };
  // A has the content the agent wrote.
  expect(await textViaToken(docA.id)).toBe("only in A");
  // B is a separate room and a separate Y.Doc: the write to A must not reach it.
  const ownerState = await (await request.get(`/api/documents/${docB.id}/state`)).json();
  const bDoc = new Y.Doc();
  Y.applyUpdate(bDoc, new Uint8Array(Buffer.from(ownerState.update, "base64")));
  expect(bDoc.getText("content").toString()).toBe("");
});

test("a non-existent document id returns 404, not a leak", async ({page, request}) => {
  await page.goto("/");
  const missing = await request.get("/api/documents/99999999/state");
  expect(missing.status()).toBe(404);
});
