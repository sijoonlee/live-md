import {expect, test, type Browser} from "@playwright/test";

// Attachment access (M21 attachments model): a file inherits its document's access.
// Read a file ⇔ read its document; attach/detach ⇔ write its document.

async function signIn(browser: Browser, name: string, opts: {admin?: boolean} = {}) {
  const context = await browser.newContext();
  const res = await context.request.post("/auth/dev-login", {data: {name, admin: opts.admin ?? false}});
  const userId = (await res.json()).user.id as number;
  return {context, request: context.request, userId};
}

async function createDoc(request: import("@playwright/test").APIRequestContext, name: string) {
  const root = (await (await request.get("/api/folders")).json()).folders[0].id as number;
  return (await (await request.post(`/api/folders/${root}/documents`, {data: {name}})).json()) as {id: number};
}

const attach = (request: import("@playwright/test").APIRequestContext, docId: number, filename: string, body: string) =>
  request.post(`/api/documents/${docId}/files?filename=${filename}`, {headers: {"content-type": "text/plain"}, data: body});

test("a file inherits its document's access", async ({browser}) => {
  const suffix = Date.now();
  const owner = await signIn(browser, `Owner ${suffix}`);
  const viewer = await signIn(browser, `Viewer ${suffix}`);
  const stranger = await signIn(browser, `Stranger ${suffix}`);
  const doc = await createDoc(owner.request, `doc-${suffix}.md`);

  const created = await attach(owner.request, doc.id, "secret.txt", "classified");
  expect(created.status()).toBe(201);
  const file = await created.json();

  // A stranger with no access to the document can't read the file or list attachments.
  expect((await stranger.request.get(`/api/files/${file.id}`)).status()).toBe(404);
  expect((await stranger.request.get(`/api/documents/${doc.id}/files`)).status()).toBe(404);

  // Share the doc as viewer → viewer can read the file and list, but not attach or delete.
  await owner.request.post(`/api/documents/${doc.id}/shares`, {data: {principalId: viewer.userId, level: "viewer"}});
  expect((await viewer.request.get(`/api/files/${file.id}`)).status()).toBe(200);
  expect((await viewer.request.get(`/api/documents/${doc.id}/files`)).status()).toBe(200);
  expect((await attach(viewer.request, doc.id, "nope.txt", "x")).status()).toBe(404); // needs write
  expect((await viewer.request.delete(`/api/files/${file.id}`)).status()).toBe(403);

  // Upgrade to editor → can now attach and detach.
  await owner.request.post(`/api/documents/${doc.id}/shares`, {data: {principalId: viewer.userId, level: "editor"}});
  expect((await attach(viewer.request, doc.id, "ok.txt", "x")).status()).toBe(201);
  expect((await viewer.request.delete(`/api/files/${file.id}`)).status()).toBe(204);

  await owner.context.close();
  await viewer.context.close();
  await stranger.context.close();
});

test("deleting a document removes (cascades) its attachments", async ({browser}) => {
  const suffix = Date.now();
  const owner = await signIn(browser, `Owner ${suffix}`);
  const doc = await createDoc(owner.request, `doc-${suffix}.md`);
  const file = await (await attach(owner.request, doc.id, "gone.txt", "bytes")).json();

  expect((await owner.request.get(`/api/files/${file.id}`)).status()).toBe(200);
  expect((await owner.request.delete(`/api/documents/${doc.id}`)).status()).toBe(204);
  // The attachment is gone with its document → its URL 404s (renders as "removed").
  expect((await owner.request.get(`/api/files/${file.id}`)).status()).toBe(404);

  await owner.context.close();
});

test("an admin can read and manage another user's document attachments", async ({browser}) => {
  const suffix = Date.now();
  const owner = await signIn(browser, `Owner ${suffix}`);
  const admin = await signIn(browser, `Admin ${suffix}`, {admin: true});
  const doc = await createDoc(owner.request, `doc-${suffix}.md`);
  const file = await (await attach(owner.request, doc.id, "a.txt", "bytes")).json();

  expect((await admin.request.get(`/api/files/${file.id}`)).status()).toBe(200);
  expect((await admin.request.delete(`/api/files/${file.id}`)).status()).toBe(204);

  await owner.context.close();
  await admin.context.close();
});
