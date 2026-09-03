import {expect, test} from "@playwright/test";

// The Share dialog offers a populated dropdown of people/agents to add (rather than
// a free-text name field).

test("shares a document with an agent picked from the dropdown", async ({page}) => {
  const suffix = Date.now();
  const agentName = `picker-bot-${suffix}`;
  await page.goto("/");

  // Create a document (owned by the signed-in user) and an agent to share with.
  const doc = await page.evaluate(async (name) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    const created = await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: `share-${name}.md`}),
    })).json();
    await fetch("/api/tokens", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name})});
    return created as {id: number};
  }, agentName);

  await page.goto(`/documents/${doc.id}`);
  await expect(page.getByTestId("document").locator(".cm-content")).toBeEditable();

  // Open Share (owner sees the affordance) and pick the agent from the dropdown.
  await page.locator("#share-document").click();
  await expect(page.locator("#share-dialog")).toBeVisible();
  const picker = page.locator("#share-principal");
  await expect(picker.locator("option", {hasText: agentName})).toHaveCount(1);
  await picker.selectOption({label: `${agentName} (agent)`});
  await page.locator("#share-add").click();

  // The agent now appears in the document's access list...
  await expect(page.locator(".share-row", {hasText: agentName})).toBeVisible();
  // ...and is gone from the picker (can't add the same principal twice).
  await expect(picker.locator("option", {hasText: agentName})).toHaveCount(0);
});
