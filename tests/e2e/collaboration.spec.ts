import {expect, test, type Page} from "@playwright/test";

// There is no default document, so editor tests create one (owned by the signed-in
// user) and open it. Returns the created document id.
async function openNewDocument(page: Page): Promise<number> {
  const doc = await page.evaluate(async () => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    return (await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.md`}),
    })).json()) as {id: number};
  });
  await page.goto(`/documents/${doc.id}`);
  await expect(page.getByTestId("document").locator(".cm-content")).toBeEditable();
  return doc.id;
}

test("two CodeMirror browser clients converge on the same document", async ({browser}) => {
  // Both clients edit, so both contexts need a signed-in session.
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  // Alice creates a document (both use the same signed-in user, so both own it).
  await alice.goto("/");
  const id = await openNewDocument(alice);
  await bob.goto(`/documents/${id}`);
  const aliceEditor = alice.getByTestId("document").locator(".cm-content");
  const bobEditor = bob.getByTestId("document").locator(".cm-content");
  await expect(aliceEditor).toBeEditable();
  await expect(bobEditor).toBeEditable();

  await aliceEditor.fill("Edited by Alice");
  await expect(bobEditor).toContainText("Edited by Alice");

  await aliceContext.close();
  await bobContext.close();
});

test("CodeMirror provides Markdown editing and line numbers", async ({page}) => {
  await page.goto("/");
  await openNewDocument(page);
  const editor = page.getByTestId("document");
  await editor.locator(".cm-content").fill("# Markdown\n\n- one\n- two");
  expect(await editor.locator(".cm-lineNumbers .cm-gutterElement").count()).toBeGreaterThanOrEqual(4);
  await expect(editor).toContainText("Markdown");
});

test("CodeMirror accepts keyboard typing", async ({page}) => {
  await page.goto("/");
  await openNewDocument(page);
  const content = page.getByTestId("document").locator(".cm-content");
  await content.click();
  await page.keyboard.type("Typed in CodeMirror");
  await expect(content).toContainText("Typed in CodeMirror");
});

test("renders Mermaid inline with a source/preview toggle", async ({page}) => {
  await page.goto("/");
  await openNewDocument(page);
  const content = page.getByTestId("document").locator(".cm-content");
  await content.fill("```mermaid\ngraph TD\n  A --> B\n```");
  const toggle = page.locator(".cm-preview-gutter-button");
  await expect(toggle).toBeVisible();
  await toggle.click();
  const widget = page.locator(".cm-preview-widget");
  await expect(widget.locator("svg")).toBeVisible();
  expect(await page.locator(".cm-line").count()).toBeLessThan(4);
  await page.locator(".cm-preview-gutter-button").click();
  await expect(widget.locator("svg")).toHaveCount(0);
});

test("renders Markdown tables inline with the same gutter toggle", async ({page}) => {
  await page.goto("/");
  await openNewDocument(page);
  const content = page.getByTestId("document").locator(".cm-content");
  await content.fill("| Name | Role |\n| --- | --- |\n| Alice | Human |");
  const toggle = page.locator(".cm-preview-gutter-button");
  await expect(toggle).toHaveAttribute("aria-label", "Show table preview");
  await toggle.click();
  await expect(page.locator(".cm-preview-widget table")).toBeVisible();
  expect(await page.locator(".cm-line").count()).toBeLessThan(3);
  await toggle.click();
  await expect(page.locator(".cm-preview-widget")).toHaveCount(0);
});

test("toggles an Explorer sidebar with folders and documents", async ({page}) => {
  await page.goto("/");
  const suffix = Date.now();
  const folderName = `Explorer folder ${suffix}`;
  const documentName = `notes-${suffix}.md`;
  const folder = await page.evaluate(async (name) => {
    const response = await fetch("/api/folders", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name})});
    return response.json();
  }, folderName);
  await page.evaluate(async ({folderId, name}) => {
    await fetch(`/api/folders/${folderId}/documents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name})});
  }, {folderId: folder.id, name: documentName});

  const toggle = page.getByRole("button", {name: "Toggle Explorer"});
  await toggle.click();
  const sidebar = page.getByTestId("directory-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toContainText(folderName);
  await expect(sidebar).toContainText(documentName);
  await toggle.click();
  await expect(sidebar).toBeHidden();
});

test("moves a document through the Explorer folder-picker overlay", async ({page}) => {
  await page.goto("/");
  const suffix = Date.now();
  const sourceName = `Move source ${suffix}`;
  const targetName = `Move target ${suffix}`;
  const documentName = `move-${suffix}.md`;
  const root = await page.evaluate(async () => (await (await fetch("/api/folders")).json()).folders[0]);
  const createFolder = async (name: string) => page.evaluate(async ({folderName, parentFolderId}) => {
    const response = await fetch("/api/folders", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: folderName, parentFolderId})});
    return response.json();
  }, {folderName: name, parentFolderId: root.id});
  const source = await createFolder(sourceName);
  const target = await createFolder(targetName);
  await page.evaluate(async ({folderId, name}) => {
    await fetch(`/api/folders/${folderId}/documents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name})});
  }, {folderId: source.id, name: documentName});

  await page.getByRole("button", {name: "Toggle Explorer"}).click();
  const sidebar = page.getByTestId("directory-sidebar");
  await expect(sidebar).toContainText(sourceName, {timeout: 10000});
  await page.getByRole("button", {name: "Refresh Explorer"}).click();
  const documentRow = sidebar.locator(".document-row", {hasText: documentName});
  await expect(documentRow).toBeVisible({timeout: 10000});
  await documentRow.click({button: "right"});
  await page.getByRole("button", {name: "Move to…"}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").locator(".move-target", {hasText: targetName}).click();
  await page.getByRole("button", {name: "Move", exact: true}).click();

  const moved = await page.evaluate(async (folderId) => (await (await fetch(`/api/folders/${folderId}/documents`)).json()).documents, target.id);
  expect(moved.some((item: {name: string}) => item.name === documentName)).toBe(true);
});

test("opens an in-app dialog for creating a folder", async ({page}) => {
  await page.goto("/");
  const folderName = `Created folder ${Date.now()}`;
  await page.getByRole("button", {name: "Toggle Explorer"}).click();
  const sidebar = page.getByTestId("directory-sidebar");
  await expect(sidebar.locator(".folder-row", {hasText: "Root"})).toBeVisible();
  await sidebar.locator(".folder-row", {hasText: "Root"}).click({button: "right"});
  await page.getByRole("button", {name: "New folder"}).click();
  const dialog = page.getByRole("dialog").filter({has: page.getByRole("heading", {name: "New folder"})});
  await expect(dialog).toBeVisible();
  await dialog.locator("#name-dialog-input").fill(folderName);
  await dialog.getByRole("button", {name: "Save"}).click();
  await expect(sidebar).toContainText(folderName);
});

// A remote edit must not disturb where the reader is working. Applying updates by
// replacing the whole document silently collapsed the caret to position 0, so
// someone typing while an agent wrote would find their next keystroke at the top of
// the document. Asserted behaviourally — type a character and check where it lands —
// because that is what the person actually experiences.
test("a remote edit leaves the caret where the person left it", async ({browser}) => {
  const readerContext = await browser.newContext();
  const writerContext = await browser.newContext();
  const reader = await readerContext.newPage();
  const writer = await writerContext.newPage();

  await reader.goto("/");
  const id = await openNewDocument(reader);
  await writer.goto(`/documents/${id}`);
  const readerEditor = reader.getByTestId("document").locator(".cm-content");
  const writerEditor = writer.getByTestId("document").locator(".cm-content");
  await expect(readerEditor).toBeEditable();
  await expect(writerEditor).toBeEditable();

  await readerEditor.fill("alpha\nbravo\ncharlie");
  await expect(writerEditor).toContainText("charlie");

  // The caret must sit in the MIDDLE of the document. A caret at the very end
  // survives even a whole-document replacement, because the end boundary maps to
  // the end of the inserted text — so testing there hides the bug entirely.
  await reader.getByText("bravo").click();
  await reader.keyboard.press("End");

  // Someone else edits well above that position.
  await writerEditor.click();
  await writer.keyboard.press("ControlOrMeta+Home");
  await writer.keyboard.type("INSERTED-AT-TOP ");
  await expect(readerEditor).toContainText("INSERTED-AT-TOP");

  // The next keystroke must land where the caret was, not at the top.
  await reader.keyboard.type("!");
  await expect(readerEditor).toContainText("bravo!");
  await expect(readerEditor).not.toContainText("!INSERTED-AT-TOP");

  await readerContext.close();
  await writerContext.close();
});
