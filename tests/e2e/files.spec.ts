import {expect, test} from "@playwright/test";

// Files are attachments of documents (M21 attachments model): you attach a file to
// a document, and it renders nested under that document in the Explorer.

async function createDocument(page: import("@playwright/test").Page, name: string) {
  return await page.evaluate(async (documentName) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    return (await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: documentName}),
    })).json()) as {id: number; name: string};
  }, name);
}

async function attach(page: import("@playwright/test").Page, documentId: number, filename: string, body: string) {
  await page.evaluate(
    async ({id, name, content}) => {
      await fetch(`/api/documents/${id}/files?filename=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: {"content-type": "text/plain"},
        body: content,
      });
    },
    {id: documentId, name: filename, content: body},
  );
}

test("attaches a file to a document through the Explorer and lists it nested", async ({page}) => {
  const docName = `Attach-${Date.now()}.md`;
  await page.goto("/");
  await createDocument(page, docName);

  await page.locator("#toggle-directory").click();
  const docRow = page.getByTestId("directory-sidebar").locator(".document-row", {hasText: docName});
  await expect(docRow).toBeVisible();

  // Right-click the document, choose "Attach file…", and supply a file to the picker.
  const fileChooserPromise = page.waitForEvent("filechooser");
  await docRow.click({button: "right"});
  await page.locator("#directory-attach-file").click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({name: "note.txt", mimeType: "text/plain", buffer: Buffer.from(`attachment for ${docName}`)});

  await expect(page.locator(".file-row", {hasText: "note.txt"})).toBeVisible();
});

test("inserts a Markdown reference to an attachment into the document", async ({page}) => {
  const docName = `Ref-${Date.now()}.md`;
  await page.goto("/");
  const doc = await createDocument(page, docName);
  await attach(page, doc.id, "spec.txt", "reference me");

  await page.locator("#toggle-directory").click();
  const docRow = page.getByTestId("directory-sidebar").locator(".document-row", {hasText: docName});
  await expect(docRow).toBeVisible();
  await docRow.click(); // open the document so it is the active editor

  const content = page.getByTestId("document").locator(".cm-content");
  await expect(content).toBeEditable();
  await content.fill("");

  const fileRow = page.locator(".file-row", {hasText: "spec.txt"});
  await expect(fileRow).toBeVisible();
  await fileRow.click({button: "right"});
  await page.locator("#directory-insert-file").click();

  // A non-image attachment becomes a plain Markdown link at the cursor.
  await expect(content).toContainText(/\[spec\.txt\]\(\/api\/files\/\d+\)/);
});

test("removes an attachment from the Explorer", async ({page}) => {
  const docName = `Del-${Date.now()}.md`;
  await page.goto("/");
  const doc = await createDocument(page, docName);
  await attach(page, doc.id, "todelete.txt", "delete me");

  await page.locator("#toggle-directory").click();
  const fileRow = page.locator(".file-row", {hasText: "todelete.txt"});
  await expect(fileRow).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await fileRow.click({button: "right"});
  await page.locator("#directory-delete").click();

  await expect(page.locator(".file-row", {hasText: "todelete.txt"})).toHaveCount(0);
});
