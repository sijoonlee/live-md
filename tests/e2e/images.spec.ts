import {expect, test, type Page} from "@playwright/test";

// A minimal valid 1x1 PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

// No default document: create one (owned by the signed-in user) and open it.
async function openNewDocument(page: Page): Promise<number> {
  const doc = await page.evaluate(async () => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    return (await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.md`}),
    })).json()) as {id: number};
  });
  await page.goto(`/documents/${doc.id}`);
  await expect(page.getByTestId("document").locator(".cm-content")).toBeEditable();
  return doc.id;
}

test("renders an uploaded image inline with the gutter toggle", async ({page}) => {
  await page.goto("/");
  const documentId = await openNewDocument(page);
  const content = page.getByTestId("document").locator(".cm-content");

  // Attach to this document through the real API and reference the URL.
  const url = await page.evaluate(async ({b64, id}) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const response = await fetch(`/api/documents/${id}/files?filename=dot.png`, {
      method: "POST",
      headers: {"content-type": "image/png"},
      body: bytes,
    });
    return (await response.json()).url as string;
  }, {b64: PNG_BASE64, id: documentId});
  expect(url).toMatch(/^\/api\/files\/\d+$/);

  await content.fill(`![a red dot](${url})`);
  const toggle = page.locator(".cm-preview-gutter-button");
  await expect(toggle).toHaveAttribute("aria-label", "Show image preview");
  await toggle.click();

  const image = page.locator(".cm-preview-image");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", url);
  // The image actually loaded (naturalWidth is 0 for broken images).
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  await toggle.click();
  await expect(page.locator(".cm-preview-widget")).toHaveCount(0);
});

test("pasting an image uploads it and inserts a Markdown reference", async ({page}) => {
  await page.goto("/");
  await openNewDocument(page);
  const content = page.getByTestId("document").locator(".cm-content");
  await content.fill("");

  // Simulate pasting an image file via a synthetic clipboard event.
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pasted.png", {type: "image/png"});
    const data = new DataTransfer();
    data.items.add(file);
    document
      .querySelector(".cm-content")!
      .dispatchEvent(new ClipboardEvent("paste", {clipboardData: data, bubbles: true, cancelable: true}));
  }, PNG_BASE64);

  // The async upload inserts a reference to the stored image.
  await expect(content).toContainText(/!\[pasted\.png\]\(\/api\/files\/\d+\)/, {timeout: 10000});

  // And it renders through the same toggle.
  await page.locator(".cm-preview-gutter-button").first().click();
  await expect(page.locator(".cm-preview-image")).toBeVisible();
});

test("dropping an image uploads it and inserts a Markdown reference", async ({page}) => {
  await page.goto("/");
  await openNewDocument(page);
  const content = page.getByTestId("document").locator(".cm-content");
  await content.fill("");
  const box = await content.boundingBox();
  if (!box) throw new Error("editor not visible");

  // Simulate dragging an image file onto the editor.
  await page.evaluate(({b64, x, y}) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "dropped.png", {type: "image/png"});
    const data = new DataTransfer();
    data.items.add(file);
    const element = document.querySelector(".cm-content")!;
    const init = {dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true};
    element.dispatchEvent(new DragEvent("dragover", init));
    element.dispatchEvent(new DragEvent("drop", init));
  }, {b64: PNG_BASE64, x: box.x + box.width / 2, y: box.y + 8});

  await expect(content).toContainText(/!\[dropped\.png\]\(\/api\/files\/\d+\)/, {timeout: 10000});
  await page.locator(".cm-preview-gutter-button").first().click();
  await expect(page.locator(".cm-preview-image")).toBeVisible();
});

test("blocks an unsafe image source instead of rendering it", async ({page}) => {
  await page.goto("/");
  await openNewDocument(page);
  const content = page.getByTestId("document").locator(".cm-content");

  await content.fill("![evil](javascript:void0)");
  const toggle = page.locator(".cm-preview-gutter-button");
  await toggle.click();

  await expect(page.locator(".cm-preview-error")).toContainText("Blocked image source");
  await expect(page.locator(".cm-preview-image")).toHaveCount(0);
});
