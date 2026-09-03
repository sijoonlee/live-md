import {expect, test, type Browser} from "@playwright/test";
import * as Y from "yjs";

// M21 phase-3 access control. Each user gets a fresh signed-in context (via the
// dev-login seam), so these exercise real per-document ownership and sharing rather
// than the shared storageState session.

const insertUpdate = (value: string) => {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
};

async function signIn(browser: Browser, name: string, opts: {admin?: boolean} = {}) {
  const context = await browser.newContext();
  const res = await context.request.post("/auth/dev-login", {data: {name, admin: opts.admin ?? false}});
  const userId = (await res.json()).user.id as number;
  return {context, request: context.request, userId};
}

async function rootFolderId(request: import("@playwright/test").APIRequestContext) {
  return (await (await request.get("/api/folders")).json()).folders[0].id as number;
}

async function createDoc(request: import("@playwright/test").APIRequestContext, name: string) {
  const root = await rootFolderId(request);
  return (await (await request.post(`/api/folders/${root}/documents`, {data: {name}})).json()) as {id: number; ownerId: number | null};
}

test("a private document is invisible to another user — 404, not 403, on every id route", async ({browser}) => {
  const suffix = Date.now();
  const owner = await signIn(browser, `Owner ${suffix}`);
  const intruder = await signIn(browser, `Intruder ${suffix}`);
  const doc = await createDoc(owner.request, `private-${suffix}.md`);

  // The owner can read it; the intruder gets a 404 that doesn't confirm existence.
  expect((await owner.request.get(`/api/documents/${doc.id}/state`)).status()).toBe(200);
  expect((await intruder.request.get(`/api/documents/${doc.id}/state`)).status()).toBe(404);

  // The intruder's own agent token can't write or move a cursor there either.
  const {token} = await (await intruder.request.post("/api/tokens", {data: {name: `intruder-${suffix}`}})).json();
  const auth = {authorization: `Bearer ${token}`};
  expect((await intruder.request.post(`/api/documents/${doc.id}/updates`, {headers: auth, data: {update: insertUpdate("x")}})).status()).toBe(404);
  expect((await intruder.request.post(`/api/documents/${doc.id}/cursor`, {headers: auth, data: {anchor: 0, head: 0}})).status()).toBe(404);

  // Scoped listing: the private doc shows for the owner, not the intruder.
  const root = await rootFolderId(owner.request);
  const ownerDocs = (await (await owner.request.get(`/api/folders/${root}/documents`)).json()).documents as {id: number}[];
  const intruderDocs = (await (await intruder.request.get(`/api/folders/${root}/documents`)).json()).documents as {id: number}[];
  expect(ownerDocs.some((d) => d.id === doc.id)).toBe(true);
  expect(intruderDocs.some((d) => d.id === doc.id)).toBe(false);

  await owner.context.close();
  await intruder.context.close();
});

test("an agent granted editor can write but cannot manage sharing", async ({browser}) => {
  const suffix = Date.now();
  const owner = await signIn(browser, `Owner ${suffix}`);
  const doc = await createDoc(owner.request, `shared-${suffix}.md`);

  const agentName = `bot-${suffix}`;
  const {token} = await (await owner.request.post("/api/tokens", {data: {name: agentName}})).json();
  const auth = {authorization: `Bearer ${token}`};

  // Before the grant, the agent has no access.
  expect((await owner.request.post(`/api/documents/${doc.id}/updates`, {headers: auth, data: {update: insertUpdate("no")}})).status()).toBe(404);

  // Grant editor.
  expect((await owner.request.post(`/api/documents/${doc.id}/shares`, {data: {agentName, level: "editor"}})).status()).toBe(201);

  // Now it can write content...
  expect((await owner.request.post(`/api/documents/${doc.id}/updates`, {headers: auth, data: {requestId: `w-${suffix}`, update: insertUpdate("hi")}})).status()).toBe(202);
  // ...but managing sharing is owner/admin-only: the manage endpoints 404 for it.
  expect((await owner.request.get(`/api/documents/${doc.id}/shares`, {headers: auth})).status()).toBe(404);
  expect((await owner.request.post(`/api/documents/${doc.id}/shares`, {headers: auth, data: {agentName, level: "viewer"}})).status()).toBe(404);

  await owner.context.close();
});

test("a viewer gets read-only access; upgrading and removing the grant take effect", async ({browser}) => {
  const suffix = Date.now();
  const owner = await signIn(browser, `Owner ${suffix}`);
  const viewer = await signIn(browser, `Viewer ${suffix}`);
  const doc = await createDoc(owner.request, `viewable-${suffix}.md`);

  await owner.request.post(`/api/documents/${doc.id}/shares`, {data: {principalId: viewer.userId, level: "viewer"}});
  const asViewer = await (await viewer.request.get(`/api/documents/${doc.id}/state`)).json();
  expect(asViewer.canEdit).toBe(false);
  expect(asViewer.canManage).toBe(false);

  // Upgrade to editor → canEdit flips true.
  await owner.request.post(`/api/documents/${doc.id}/shares`, {data: {principalId: viewer.userId, level: "editor"}});
  expect((await (await viewer.request.get(`/api/documents/${doc.id}/state`)).json()).canEdit).toBe(true);

  // Remove the grant → back to 404.
  expect((await owner.request.delete(`/api/documents/${doc.id}/shares/${viewer.userId}`)).status()).toBe(204);
  expect((await viewer.request.get(`/api/documents/${doc.id}/state`)).status()).toBe(404);

  await owner.context.close();
  await viewer.context.close();
});

test("an admin bypasses ownership and can read any private document", async ({browser}) => {
  const suffix = Date.now();
  const owner = await signIn(browser, `Owner ${suffix}`);
  const admin = await signIn(browser, `Admin ${suffix}`, {admin: true});
  const doc = await createDoc(owner.request, `admin-${suffix}.md`);

  expect((await admin.request.get(`/api/documents/${doc.id}/state`)).status()).toBe(200);
  // And admin can manage sharing on a document it does not own.
  expect((await admin.request.get(`/api/documents/${doc.id}/shares`)).status()).toBe(200);

  await owner.context.close();
  await admin.context.close();
});
