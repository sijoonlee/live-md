import {expect, test, type Page} from "@playwright/test";
import {createZip, readZip} from "../../src/zip.js";
import {AgentClient} from "../../src/agent-client.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x10, 0x20, 0x30, 0x40]);

// M19 build-order step 1: plain Markdown export.

async function createAndOpen(page: Page, name: string): Promise<number> {
  const doc = await page.evaluate(async (documentName) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    return (await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({name: documentName}),
    })).json()) as {id: number};
  }, name);
  await page.goto(`/documents/${doc.id}`);
  await expect(page.getByTestId("document").locator(".cm-content")).toBeEditable();
  return doc.id;
}

test("exports a document as Markdown with a .md download filename", async ({page}) => {
  await page.goto("/");
  const id = await createAndOpen(page, `Export-${Date.now()}.md`);
  await page.getByTestId("document").locator(".cm-content").fill("# Exported\n\nhello world");

  // The edit reaches the server (over the WS) before it can be exported; poll the endpoint.
  await expect.poll(async () => {
    const res = await page.request.get(`/api/documents/${id}/export`);
    return (await res.text());
  }, {timeout: 5000}).toContain("# Exported");

  const res = await page.request.get(`/api/documents/${id}/export`);
  expect(res.headers()["content-type"]).toContain("text/markdown");
  expect(res.headers()["content-disposition"]).toMatch(/attachment; filename=".*\.md"/);
  expect(await res.text()).toContain("hello world");
});

test("the Explorer's Export Markdown action downloads the document", async ({page}) => {
  const docName = `MenuExport-${Date.now()}.md`;
  await page.goto("/");
  const id = await createAndOpen(page, docName);
  await page.getByTestId("document").locator(".cm-content").fill("menu export body");
  // Ensure the content has reached the server.
  await expect.poll(async () => (await (await page.request.get(`/api/documents/${id}/export`)).text()), {timeout: 5000})
    .toContain("menu export body");

  await page.locator("#toggle-directory").click();
  const docRow = page.getByTestId("directory-sidebar").locator(".document-row", {hasText: docName});
  await expect(docRow).toBeVisible();
  await docRow.click({button: "right"});

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#directory-export-document").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.md$/);
});

test("exports a document with an attachment as a .zip bundle (links rewritten)", async ({page}) => {
  await page.goto("/");
  const id = await createAndOpen(page, `Bundle-${Date.now()}.md`);

  // Attach a file and reference it from the document text.
  const fileId = await page.evaluate(async (docId) => {
    const res = await fetch(`/api/documents/${docId}/files?filename=note.txt`, {
      method: "POST", headers: {"content-type": "text/plain"}, body: "attachment bytes",
    });
    return (await res.json()).id as number;
  }, id);
  await page.getByTestId("document").locator(".cm-content").fill(`See [note](/api/files/${fileId}) here.`);

  // Poll until the referenced text has reached the server (export then returns a zip).
  await expect.poll(async () => (await page.request.get(`/api/documents/${id}/export`)).headers()["content-type"], {timeout: 5000})
    .toContain("application/zip");

  const res = await page.request.get(`/api/documents/${id}/export`);
  expect(res.headers()["content-disposition"]).toMatch(/attachment; filename=".*\.zip"/);
  const entries = readZip(new Uint8Array(await res.body()));
  const md = entries.find((e) => e.name.endsWith(".md"))!;
  const asset = entries.find((e) => e.name === "assets/note.txt")!;
  expect(asset).toBeTruthy();
  expect(Buffer.from(asset.bytes).toString()).toBe("attachment bytes");
  // The link is rewritten to the bundled path.
  expect(Buffer.from(md.bytes).toString()).toContain("[note](assets/note.txt)");
  expect(Buffer.from(md.bytes).toString()).not.toContain("/api/files/");
});

test("imports a Markdown file as a new document (round-trips through export)", async ({page}) => {
  const markdown = "# Imported doc\n\n- one\n- two\n";
  const name = `Imported-${Date.now()}.md`;
  await page.goto("/");
  await createAndOpen(page, `seed-${Date.now()}.md`); // ensure the app is signed in and loaded

  const created = await page.evaluate(async ({body, filename}) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    const res = await fetch(`/api/folders/${root.id}/import?filename=${encodeURIComponent(filename)}`, {
      method: "POST", headers: {"content-type": "text/markdown"}, body,
    });
    return {status: res.status, doc: await res.json()};
  }, {body: markdown, filename: name});
  expect(created.status).toBe(201);
  expect(created.doc.name).toBe(name);

  // The imported content round-trips: exporting the new document returns the same text.
  await expect.poll(async () => (await (await page.request.get(`/api/documents/${created.doc.id}/export`)).text()), {timeout: 5000})
    .toContain("# Imported doc");
  const exported = await (await page.request.get(`/api/documents/${created.doc.id}/export`)).text();
  expect(exported).toContain("- one");
  expect(exported).toContain("- two");
});

test("the Explorer's Import Markdown action creates and opens a document", async ({page}) => {
  await page.goto("/");
  await createAndOpen(page, `anchor-${Date.now()}.md`);
  await page.locator("#toggle-directory").click();

  // Right-click the Root folder and choose Import Markdown, then supply a file.
  const rootRow = page.getByTestId("directory-sidebar").locator(".folder-row").first();
  await rootRow.click({button: "right"});
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#directory-import-document").click();
  const chooser = await fileChooserPromise;
  const filename = `MenuImport-${Date.now()}.md`;
  await chooser.setFiles({name: filename, mimeType: "text/markdown", buffer: Buffer.from("# From the menu\n\nimported here")});

  // The new document opens in the editor with its imported content.
  await expect(page.getByTestId("document").locator(".cm-content")).toContainText("From the menu");
  await expect(page.getByTestId("directory-sidebar").locator(".document-row", {hasText: filename})).toBeVisible();
});

test("imports a .zip bundle: uploads the asset and rewrites its link", async ({page}) => {
  await page.goto("/");
  await createAndOpen(page, `zip-anchor-${Date.now()}.md`);

  const name = `Bundled-${Date.now()}.md`;
  const zip = createZip([
    {name: name, bytes: Buffer.from("Intro\n\n![pic](assets/pic.png)\n[doc](assets/data.txt)\n")},
    {name: "assets/pic.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])}, // PNG magic
    {name: "assets/data.txt", bytes: Buffer.from("plain data")},
  ]);

  // Upload the zip through the import endpoint.
  const created = await page.evaluate(async ({bytes, filename}) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    const res = await fetch(`/api/folders/${root.id}/import?filename=${encodeURIComponent(filename)}`, {
      method: "POST", headers: {"content-type": "application/zip"}, body: new Uint8Array(bytes),
    });
    return {status: res.status, doc: await res.json()};
  }, {bytes: Array.from(zip), filename: name});
  expect(created.status).toBe(201);

  // Both assets became attachments of the new document.
  const files = await page.evaluate(async (id) => (await (await fetch(`/api/documents/${id}/files`)).json()).files, created.doc.id);
  const names = (files as {filename: string}[]).map((f) => f.filename).sort();
  expect(names).toEqual(["data.txt", "pic.png"]);

  // The text's assets/ links were rewritten to /api/files/:id (exported bundle round-trips back).
  await expect.poll(async () => (await page.request.get(`/api/documents/${created.doc.id}/export`)).headers()["content-type"], {timeout: 5000})
    .toContain("application/zip");
  const entries = readZip(new Uint8Array(await (await page.request.get(`/api/documents/${created.doc.id}/export`)).body()));
  const md = Buffer.from(entries.find((e) => e.name.endsWith(".md"))!.bytes).toString();
  expect(md).toContain("![pic](assets/pic.png)");
  expect(md).toContain("[doc](assets/data.txt)");
});

test("import rejects binary (non-UTF-8) content", async ({page}) => {
  await page.goto("/");
  await createAndOpen(page, `bin-anchor-${Date.now()}.md`);
  const status = await page.evaluate(async () => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    // A NUL byte marks this as binary, not Markdown text.
    const res = await fetch(`/api/folders/${root.id}/import?filename=bin.md`, {
      method: "POST", headers: {"content-type": "application/octet-stream"},
      body: new Uint8Array([0x00, 0x01, 0x02]),
    });
    return res.status;
  });
  expect(status).toBe(415);
});

test("full round-trip: export a doc with an image, re-import, the image survives", async ({page}) => {
  await page.goto("/");
  const id = await createAndOpen(page, `RoundTrip-${Date.now()}.md`);

  // Attach a PNG and reference it.
  const fileId = await page.evaluate(async ({docId, bytes}) => {
    const res = await fetch(`/api/documents/${docId}/files?filename=pic.png`, {
      method: "POST", headers: {"content-type": "image/png"}, body: new Uint8Array(bytes),
    });
    return (await res.json()).id as number;
  }, {docId: id, bytes: Array.from(PNG)});
  await page.getByTestId("document").locator(".cm-content").fill(`# Pic\n\n![pic](/api/files/${fileId})\n`);
  await expect.poll(async () => (await page.request.get(`/api/documents/${id}/export`)).headers()["content-type"], {timeout: 5000})
    .toContain("application/zip");

  // Export the bundle, then re-import those exact bytes as a new document.
  const zipBytes = new Uint8Array(await (await page.request.get(`/api/documents/${id}/export`)).body());
  const newDoc = await page.evaluate(async ({bytes}) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    const res = await fetch(`/api/folders/${root.id}/import?filename=reimported.md`, {
      method: "POST", headers: {"content-type": "application/zip"}, body: new Uint8Array(bytes),
    });
    return await res.json();
  }, {bytes: Array.from(zipBytes)});

  // The image is re-attached and its bytes are byte-identical to the original.
  const newFiles = await page.evaluate(async (docId) => (await (await fetch(`/api/documents/${docId}/files`)).json()).files, newDoc.id);
  expect((newFiles as {filename: string}[]).map((f) => f.filename)).toEqual(["pic.png"]);
  const served = new Uint8Array(await (await page.request.get((newFiles as {url: string}[])[0].url)).body());
  expect(served).toEqual(PNG);
});

test("export surfaces notes for broken references and orphan attachments", async ({page}) => {
  await page.goto("/");
  const id = await createAndOpen(page, `Warn-${Date.now()}.md`);

  // One referenced attachment (bundled), one unreferenced attachment (orphan).
  const refId = await page.evaluate(async (docId) => (await (await fetch(`/api/documents/${docId}/files?filename=used.txt`, {
    method: "POST", headers: {"content-type": "text/plain"}, body: "used",
  })).json()).id, id);
  await page.evaluate(async (docId) => fetch(`/api/documents/${docId}/files?filename=orphan.txt`, {
    method: "POST", headers: {"content-type": "text/plain"}, body: "orphan",
  }), id);
  // Reference the real one and a bogus (broken) id.
  await page.getByTestId("document").locator(".cm-content").fill(`[a](/api/files/${refId}) and [b](/api/files/99999)`);
  await expect.poll(async () => (await page.request.get(`/api/documents/${id}/export`)).headers()["content-type"], {timeout: 5000})
    .toContain("application/zip");

  const warnings = decodeURIComponent((await page.request.get(`/api/documents/${id}/export`)).headers()["x-export-warnings"] ?? "");
  expect(warnings).toMatch(/referenced file\(s\) are not attachments/);
  expect(warnings).toMatch(/unreferenced attachment\(s\) were not included/);
});

test("agent SDK round-trips a document via export then import", async ({page, baseURL}) => {
  await page.goto("/");
  const id = await createAndOpen(page, `AgentRT-${Date.now()}.md`);
  await page.getByTestId("document").locator(".cm-content").fill("# Agent export\n\nround trip");

  const agentName = `rt-bot-${Date.now()}`;
  const {token} = await page.evaluate(async (name) =>
    (await (await fetch("/api/tokens", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name})})).json()),
    agentName);
  await page.evaluate(async ({docId, name}) => fetch(`/api/documents/${docId}/shares`, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({agentName: name, level: "editor"}),
  }), {docId: id, name: agentName});

  const agent = new AgentClient({baseUrl: baseURL!, agentId: agentName, token, documentId: id});
  await expect.poll(async () => (await agent.exportDocument()).bytes.length, {timeout: 5000}).toBeGreaterThan(10);
  const exported = await agent.exportDocument();
  expect(exported.contentType).toContain("text/markdown"); // no attachments -> plain .md
  expect(Buffer.from(exported.bytes).toString()).toContain("round trip");

  const root = (await agent.listFolders())[0];
  const imported = await agent.importDocument(root.id, exported.bytes, {filename: "agent-copy.md"});
  const copy = new AgentClient({baseUrl: baseURL!, agentId: agentName, token, documentId: imported.id});
  expect(await copy.load()).toContain("round trip");
});

test("export requires read access — a stranger gets 404", async ({browser}) => {
  const suffix = Date.now();
  const owner = await browser.newContext();
  await owner.request.post("/auth/dev-login", {data: {name: `Owner ${suffix}`, admin: false}});
  const stranger = await browser.newContext();
  await stranger.request.post("/auth/dev-login", {data: {name: `Stranger ${suffix}`, admin: false}});

  const root = (await (await owner.request.get("/api/folders")).json()).folders[0].id as number;
  const doc = (await (await owner.request.post(`/api/folders/${root}/documents`, {data: {name: `private-${suffix}.md`}})).json()) as {id: number};

  expect((await owner.request.get(`/api/documents/${doc.id}/export`)).status()).toBe(200);
  expect((await stranger.request.get(`/api/documents/${doc.id}/export`)).status()).toBe(404);

  await owner.close();
  await stranger.close();
});
