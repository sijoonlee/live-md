import {expect, test} from "@playwright/test";

// Signed in via the project storageState. Exercises the M21 phase-2 document UI:
// opening documents from the Explorer, /documents/:id addressing, deep links, and
// back/forward navigation.

const createDoc = (page: import("@playwright/test").Page, name: string) =>
  page.evaluate(async (documentName) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    return (await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: documentName}),
    })).json()) as {id: number; name: string};
  }, name);

const openExplorerRow = async (page: import("@playwright/test").Page, name: string) => {
  const sidebar = page.getByTestId("directory-sidebar");
  // Toggle the Explorer open only when it is currently hidden (calling this twice
  // must not toggle it closed again).
  if (!(await sidebar.isVisible())) await page.getByRole("button", {name: "Toggle Explorer"}).click();
  await page.getByRole("button", {name: "Refresh Explorer"}).click();
  const row = sidebar.locator(".document-row", {hasText: name});
  await expect(row).toBeVisible({timeout: 10000});
  return row;
};

test("/ shows the welcome state (no default document)", async ({page}) => {
  await page.goto("/");
  await expect(page.locator("#app-main")).toBeVisible();
  await expect(page.locator(".welcome-message")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("opening a document from the Explorer updates the URL and title", async ({page}) => {
  const name = `nav-open-${Date.now()}.md`;
  await page.goto("/");
  const doc = await createDoc(page, name);
  const row = await openExplorerRow(page, name);
  await row.click();

  await expect(page).toHaveURL(new RegExp(`/documents/${doc.id}$`));
  await expect(page.locator("#document-title")).toHaveText(name);
  await expect(page.getByTestId("document").locator(".cm-content")).toBeEditable();
  await expect(row).toHaveClass(/active/);
});

test("a deep link opens that document directly", async ({page}) => {
  const name = `nav-deep-${Date.now()}.md`;
  await page.goto("/");
  const doc = await createDoc(page, name);

  await page.goto(`/documents/${doc.id}`);
  await expect(page.locator("#document-title")).toHaveText(name);
  await expect(page.getByTestId("document").locator(".cm-content")).toBeEditable();
});

test("back and forward navigate between opened documents", async ({page}) => {
  const suffix = Date.now();
  const nameA = `nav-a-${suffix}.md`;
  const nameB = `nav-b-${suffix}.md`;
  await page.goto("/");
  const docA = await createDoc(page, nameA);
  const docB = await createDoc(page, nameB);

  await (await openExplorerRow(page, nameA)).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${docA.id}$`));
  await (await openExplorerRow(page, nameB)).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${docB.id}$`));

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/documents/${docA.id}$`));
  await expect(page.locator("#document-title")).toHaveText(nameA);

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/documents/${docB.id}$`));
  await expect(page.locator("#document-title")).toHaveText(nameB);
});

test("a deep link to a non-existent document shows a not-found message", async ({page}) => {
  await page.goto("/documents/99999999");
  await expect(page.locator("#document-title")).toHaveText("Document not found");
  await expect(page.getByTestId("document")).toContainText("do not have access");
});
