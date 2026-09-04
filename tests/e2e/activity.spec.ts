import {expect, test} from "@playwright/test";
import {callToolJson} from "./mcp-client";

// M12: the activity/history feed. It is durable — backed by the append-only
// document_activity table, NOT the compactable CRDT update log — so it retains history
// the M10 snapshot compaction drops.

type HistoryEntry = {id: string; revision: number; author: string; metadata?: {reason?: string}};

test("history records each edit with author and a durable id, and outlives compaction", async ({page, request}) => {
  await page.goto("/");
  const agentName = `activity-bot-${Date.now()}`;
  const docId = await page.evaluate(async (name) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    const doc = await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: `activity-${name}.md`}),
    })).json();
    return doc.id as number;
  }, agentName);

  // Drive 55 edits over MCP. Snapshot compaction fires at 50 updates, deleting the
  // covered rows from the CRDT update log — but the activity log must keep all 55.
  for (let i = 0; i < 55; i += 1) {
    await callToolJson(request, agentName, "append_document", {documentId: docId, content: "x"});
  }

  const {entries} = await (await request.get(`/api/documents/${docId}/history?limit=100`)).json() as {entries: HistoryEntry[]};
  expect(entries.length).toBe(55);
  // Newest-first, each with a distinct durable id and the server-set author label.
  expect(entries[0].revision).toBe(55);
  expect(new Set(entries.map((e) => e.id)).size).toBe(55);
  expect(entries[0].author).toBe(agentName);
  expect(entries[0].metadata?.reason).toBe("mcp:append_document");
  // The oldest edit (revision 1) is still present, though its CRDT update row was
  // compacted away — history is durable, not the compactable tail.
  expect(entries.at(-1)!.revision).toBe(1);
});

test("the History panel lists edits and appends a collaborator's edit live", async ({browser}) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  await alice.goto("/");
  const id = await alice.evaluate(async () => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    return (await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: `hist-ui-${Date.now()}.md`}),
    })).json()).id as number;
  });

  // Alice opens the doc, makes an edit, and opens History → the edit is listed.
  await alice.goto(`/documents/${id}`);
  const aliceContent = alice.getByTestId("document").locator(".cm-content");
  await expect(aliceContent).toBeEditable();
  await aliceContent.click();
  await alice.keyboard.type("alice was here");
  await alice.getByRole("button", {name: "History"}).click();
  const panel = alice.getByTestId("activity-panel");
  await expect(panel.locator(".activity-item").first()).toContainText("rev");
  const before = await panel.locator(".activity-item").count();
  expect(before).toBeGreaterThan(0);

  // Bob edits the same document; Alice's open panel appends his edit live (WS broadcast).
  await bob.goto(`/documents/${id}`);
  await expect(bob.getByTestId("document").locator(".cm-content")).toBeEditable();
  await bob.getByTestId("document").locator(".cm-content").click();
  await bob.keyboard.type("bob too");
  await expect.poll(async () => panel.locator(".activity-item").count()).toBeGreaterThan(before);

  await aliceCtx.close();
  await bobCtx.close();
});
