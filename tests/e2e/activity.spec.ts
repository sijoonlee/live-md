import {expect, test} from "@playwright/test";
import {authFile} from "./auth-file";
import {AgentClient} from "../../src/agent-client.js";

// M12: the activity/history feed. It is durable — backed by the append-only
// document_activity table, NOT the compactable CRDT update log — so it retains history
// the M10 snapshot compaction drops.

async function setupOwnedDocWithAgent(page: import("@playwright/test").Page) {
  await page.goto("/");
  const agentName = `activity-bot-${Date.now()}`;
  return await page.evaluate(async (name) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    const doc = await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: `activity-${name}.md`}),
    })).json();
    const {token} = await (await fetch("/api/tokens", {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name}),
    })).json();
    await fetch(`/api/documents/${doc.id}/shares`, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({agentName: name, level: "editor"}),
    });
    return {docId: doc.id as number, token: token as string, agentName: name};
  }, agentName);
}

test("history records each edit with author and a durable id, and outlives compaction", async ({page, baseURL}) => {
  const {docId, token, agentName} = await setupOwnedDocWithAgent(page);

  // Drive 55 edits through the SDK. Snapshot compaction fires at 50 updates, deleting the
  // covered rows from the CRDT update log — but the activity log must keep all 55.
  const agent = new AgentClient({baseUrl: baseURL!, agentId: agentName, token, documentId: docId});
  await agent.load();
  for (let i = 0; i < 55; i += 1) await agent.insert(agent.text.length, "x", {reason: `edit-${i}`});

  const full = await agent.history({limit: 100});
  expect(full.length).toBe(55);
  // Newest-first, each with a distinct durable id and the server-set agent author.
  expect(full[0].revision).toBe(55);
  expect(new Set(full.map((e) => e.id)).size).toBe(55);
  expect(full[0].author.kind).toBe("agent");
  expect(full[0].author.displayName).toBe(agentName);
  expect(full[0].metadata?.reason).toBe("edit-54");
  // The oldest edit (revision 1) is still present, though its CRDT update row was
  // compacted away — history is durable, not the compactable tail.
  expect(full.at(-1)!.revision).toBe(1);
});

test("the History panel lists edits and appends a collaborator's edit live", async ({browser}) => {
  const aliceCtx = await browser.newContext({storageState: authFile});
  const bobCtx = await browser.newContext({storageState: authFile});
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

test("history is read-gated: a stranger gets 404", async ({browser}) => {
  const suffix = Date.now();
  const owner = await browser.newContext();
  await owner.request.post("/auth/dev-login", {data: {name: `Owner ${suffix}`, admin: false}});
  const stranger = await browser.newContext();
  await stranger.request.post("/auth/dev-login", {data: {name: `Stranger ${suffix}`, admin: false}});

  const root = (await (await owner.request.get("/api/folders")).json()).folders[0].id as number;
  const doc = (await (await owner.request.post(`/api/folders/${root}/documents`, {data: {name: `hist-${suffix}.md`}})).json()) as {id: number};

  expect((await owner.request.get(`/api/documents/${doc.id}/history`)).status()).toBe(200);
  expect((await stranger.request.get(`/api/documents/${doc.id}/history`)).status()).toBe(404);

  await owner.close();
  await stranger.close();
});
