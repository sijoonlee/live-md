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

  // A token authenticates the id-keyed write endpoint (HTTP writes are agent-only).
  // The docs are private to their owner (the signed-in test user), so the agent is
  // granted editor on A only — B stays off-limits to it.
  const agentName = `iso-agent-${suffix}`;
  const {token} = await (await request.post("/api/tokens", {data: {name: agentName}})).json();
  const auth = {authorization: `Bearer ${token}`};
  const grant = await request.post(`/api/documents/${docA.id}/shares`, {data: {agentName, level: "editor"}});
  expect(grant.status()).toBe(201);

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
  // B was never shared with the agent — it can't even read it (404, not a leak).
  expect((await request.get(`/api/documents/${docB.id}/state`, {headers: auth})).status()).toBe(404);
  // The owner (session) reads B directly and finds it untouched.
  const ownerState = await (await request.get(`/api/documents/${docB.id}/state`)).json();
  const bDoc = new Y.Doc();
  Y.applyUpdate(bDoc, new Uint8Array(Buffer.from(ownerState.update, "base64")));
  expect(bDoc.getText("content").toString()).toBe("");

  // The creating principal is recorded as the owner.
  expect(docA.ownerId).not.toBeNull();
});

test("a non-existent document id returns 404, not a leak", async ({page, request}) => {
  await page.goto("/");
  const missing = await request.get("/api/documents/99999999/state");
  expect(missing.status()).toBe(404);
});
