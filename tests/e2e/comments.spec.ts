import {expect, test, type Browser, type Page} from "@playwright/test";
import {authFile} from "./auth-file";
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

async function signIn(browser: Browser, name: string) {
  const context = await browser.newContext();
  await context.request.post("/auth/dev-login", {data: {name, admin: false}});
  return context;
}

test("a viewer sees comments read-only; an editor gets the add/reply affordances", async ({browser}) => {
  const suffix = Date.now();
  const ownerContext = await signIn(browser, `Owner ${suffix}`);
  const viewerContext = await signIn(browser, `Viewer ${suffix}`);
  const owner = await ownerContext.newPage();

  // Owner creates a doc and leaves a comment through the UI.
  await owner.goto("/");
  const id = await openNewDocument(owner);
  await owner.getByTestId("document").locator(".cm-content").fill("shared paragraph");
  await owner.getByText("shared paragraph").click();
  await addCommentOnCursorLine(owner, "owner note");

  // Find the viewer's principal id and grant viewer access.
  const viewerId = (await (await viewerContext.request.get("/api/me")).json()).user.id as number;
  await owner.evaluate(async ({docId, principalId}) => {
    await fetch(`/api/documents/${docId}/shares`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({principalId, level: "viewer"}),
    });
  }, {docId: id, principalId: viewerId});

  // The viewer opens the doc: read-only editor, sees the 💬 marker, but no "+" add.
  const viewer = await viewerContext.newPage();
  await viewer.goto(`/documents/${id}`);
  await expect(viewer.getByTestId("document").locator(".cm-content")).not.toBeEditable();
  await expect(viewer.locator(".cm-comment-gutter-marker")).toBeVisible();
  await expect(viewer.locator(".cm-comment-gutter-add")).toHaveCount(0);

  // Opening the thread shows the comment but offers no reply/resolve controls.
  await viewer.locator(".cm-comment-gutter-marker").click();
  const popover = viewer.locator(".comment-popover");
  await expect(popover).toContainText("owner note");
  await expect(popover.getByRole("button", {name: "Reply"})).toHaveCount(0);
  await expect(popover.getByRole("button", {name: "Resolve"})).toHaveCount(0);

  await ownerContext.close();
  await viewerContext.close();
});

test("an agent comment (SDK) shows in the browser, and a browser comment reaches the agent", async ({page, baseURL}) => {
  await page.goto("/");
  const id = await openNewDocument(page);
  await page.getByTestId("document").locator(".cm-content").fill("agent target line\nsecond paragraph");

  // Mint an agent token and grant it editor access to this document.
  const agentName = `comment-bot-${Date.now()}`;
  const {token} = await page.evaluate(async (name) => {
    const created = await (await fetch("/api/tokens", {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name}),
    })).json();
    return created as {token: string};
  }, agentName);
  await page.evaluate(async ({docId, name}) => {
    await fetch(`/api/documents/${docId}/shares`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({agentName: name, level: "editor"}),
    });
  }, {docId: id, name: agentName});

  const agent = new AgentClient({baseUrl: baseURL!, agentId: agentName, token, documentId: id});
  await agent.load();
  const commentId = await agent.addComment({line: 1, body: "comment from the agent"});
  expect(commentId).toBeTruthy();

  // The agent's comment surfaces in the browser panel.
  await page.getByRole("button", {name: "Comments"}).click();
  const panel = page.getByTestId("comments-panel");
  await expect(panel.locator(".comments-panel-item")).toContainText("comment from the agent");

  // A comment added in the browser (on a different, comment-free line) reaches the agent.
  await page.getByText("second paragraph").click();
  await addCommentOnCursorLine(page, "comment from the browser");
  await expect.poll(async () => {
    await agent.sync();
    return agent.listComments().some((c) => c.body === "comment from the browser");
  }, {timeout: 5000}).toBe(true);
});
