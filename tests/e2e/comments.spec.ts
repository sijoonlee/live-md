import {expect, test, type Page} from "@playwright/test";
import {AgentClient} from "../../src/agent-client.js";

// M8 comments: line-anchored threads stored in the Y.Doc, gutter markers, the thread
// popover, the panel, resolve, viewer-vs-editor gating, persistence/sync, and the SDK.

async function openNewDocument(page: Page): Promise<number> {
  const doc = await page.evaluate(async () => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    return (await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: `comments-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.md`}),
    })).json()) as {id: number};
  });
  await page.goto(`/documents/${doc.id}`);
  await expect(page.getByTestId("document").locator(".cm-content")).toBeEditable();
  return doc.id;
}

// Add a root comment on the line currently containing the cursor, via the gutter "+".
async function addCommentOnCursorLine(page: Page, body: string) {
  await page.locator(".cm-comment-gutter-add").click({force: true});
  const popover = page.locator(".comment-popover");
  await expect(popover).toBeVisible();
  await popover.locator(".comment-input").fill(body);
  await popover.getByRole("button", {name: "Comment"}).click();
  await expect(popover).toBeHidden();
}

test("add a line comment: gutter marker, thread popover, and it tracks inserted lines", async ({page}) => {
  await page.goto("/");
  const id = await openNewDocument(page);
  const content = page.getByTestId("document").locator(".cm-content");
  await content.fill("line one\nline two\nline three");

  // Place the cursor on line two, then comment on it.
  await page.getByText("line two").click();
  await addCommentOnCursorLine(page, "look at this line");

  // A 💬 marker now shows, and the panel reports the comment on line 2.
  await expect(page.locator(".cm-comment-gutter-marker")).toBeVisible();
  await page.getByRole("button", {name: "Comments"}).click();
  const panel = page.getByTestId("comments-panel");
  await expect(panel.locator(".comments-panel-item")).toContainText("line 2");
  await expect(panel.locator(".comments-panel-item")).toContainText("look at this line");

  // Insert a line above the anchored line; the comment tracks down to line 3.
  await page.getByText("line one").click();
  await page.keyboard.press("Home");
  await page.keyboard.type("brand new line\n");
  await expect(panel.locator(".comments-panel-item")).toContainText("line 3");

  // It survives a reload (persisted in the Y.Doc, no separate store).
  await page.goto(`/documents/${id}`);
  await expect(page.locator(".cm-comment-gutter-marker")).toBeVisible();
});

test("reply and resolve: resolving clears the gutter and files it under Resolved", async ({page}) => {
  await page.goto("/");
  await openNewDocument(page);
  const content = page.getByTestId("document").locator(".cm-content");
  await content.fill("discuss me");
  await page.getByText("discuss me").click();
  await addCommentOnCursorLine(page, "first thought");

  // Open the thread and reply.
  await page.locator(".cm-comment-gutter-marker").click();
  let popover = page.locator(".comment-popover");
  await popover.locator(".comment-input").fill("a reply");
  await popover.getByRole("button", {name: "Reply"}).click();
  await expect(popover).toContainText("a reply");

  // Resolve the thread → the gutter marker disappears.
  await popover.getByRole("button", {name: "Resolve"}).click();
  await expect(page.locator(".cm-comment-gutter-marker")).toHaveCount(0);

  // The panel hides it until "Show resolved" is checked; then it appears under Resolved.
  await page.getByRole("button", {name: "Comments"}).click();
  const panel = page.getByTestId("comments-panel");
  await expect(panel.locator(".comments-panel-item")).toHaveCount(0);
  await panel.locator("#comments-show-resolved").check();
  await expect(panel.locator(".comments-panel-item.resolved")).toContainText("first thought");
});
