import {expect, test} from "@playwright/test";

// Tests run signed in by default (project storageState). The signed-out group below
// opts out to exercise the anonymous paths.
test.describe("signed out", () => {
  test.use({storageState: {cookies: [], origins: []}});

  const bodilessUpdate = {requestId: "test-req", update: "AAA"};

  test("rejects a document update with no token", async ({request}) => {
    const response = await request.post("/api/documents/1/updates", {data: bodilessUpdate});
    expect(response.status()).toBe(401);
  });

  test("rejects a document update with an invalid token", async ({request}) => {
    const response = await request.post("/api/documents/1/updates", {
      headers: {authorization: "Bearer agt_not-a-real-token"},
      data: bodilessUpdate,
    });
    expect(response.status()).toBe(401);
  });

  test("rejects a cursor publish with no token", async ({request}) => {
    const response = await request.post("/api/documents/1/cursor", {data: {anchor: 0, head: 0}});
    expect(response.status()).toBe(401);
  });

  test("token API requires a human session", async ({request}) => {
    expect((await request.get("/api/tokens")).status()).toBe(401);
    expect((await request.post("/api/tokens", {data: {name: "nope"}})).status()).toBe(401);
  });

  test("read and directory APIs require authentication", async ({request}) => {
    // Reads are locked down...
    expect((await request.get("/api/documents/1/state")).status()).toBe(401);
    expect((await request.get("/api/folders")).status()).toBe(401);
    // ...as are directory/file mutations.
    expect((await request.post("/api/folders", {data: {name: "x"}})).status()).toBe(401);
    // Sign-in status stays public.
    expect((await request.get("/api/me")).status()).toBe(200);
  });

  test("shows a sign-in gate on the token panel when signed out", async ({page}) => {
    await page.goto("/");
    await page.locator("#toggle-tokens").click();
    await expect(page.locator("#token-auth-gate")).toBeVisible();
    await expect(page.locator("#token-authed")).toBeHidden();
  });

  test("gates the app and Explorer for anonymous visitors", async ({page}) => {
    await page.goto("/");
    // The main area shows a sign-in screen instead of the document.
    await expect(page.getByTestId("signin-screen")).toBeVisible();
    await expect(page.locator("#app-main")).toBeHidden();
    // The Explorer shows a sign-in gate instead of the tree.
    await page.locator("#toggle-directory").click();
    await expect(page.locator("#directory-auth-gate")).toBeVisible();
    await expect(page.locator("#directory-authed")).toBeHidden();
  });
});

test("shows the welcome state, not the sign-in screen, when signed in at /", async ({page}) => {
  await page.goto("/");
  await expect(page.locator("#app-main")).toBeVisible();
  await expect(page.getByTestId("signin-screen")).toBeHidden();
  // No default document: "/" shows the welcome/empty state, not an editor.
  await expect(page.locator(".welcome-message")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("creates, uses, and revokes an agent token from the tokens panel", async ({page, request}) => {
  const name = `UI-${Date.now()}`;
  // Signed in via the project storageState.
  await page.goto("/");
  await page.locator("#toggle-tokens").click();
  await expect(page.locator("#token-sidebar")).toBeVisible();
  await expect(page.locator("#token-authed")).toBeVisible();

  // Create a token; it is shown once.
  await page.locator("#token-name-input").fill(name);
  await page.locator("#token-create").click();
  const created = page.locator("#token-created-input");
  await expect(created).toBeVisible();
  const token = await created.inputValue();
  expect(token).toMatch(/^agt_/);
  await expect(page.locator(".token-row", {hasText: name})).toBeVisible();

  // Give the agent something to write to: an owned document shared with it (by name).
  const root = (await (await request.get("/api/folders")).json()).folders[0].id;
  const doc = await (await request.post(`/api/folders/${root}/documents`, {data: {name: `${name}.md`}})).json();
  await request.post(`/api/documents/${doc.id}/shares`, {data: {agentName: name, level: "editor"}});

  // The token authenticates a write endpoint on that document.
  const authed = await request.post(`/api/documents/${doc.id}/cursor`, {
    headers: {authorization: `Bearer ${token}`},
    data: {anchor: 0, head: 0},
  });
  expect(authed.status()).toBe(200);

  // Revoke it from the panel; the row disappears and the token stops working.
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#token-created-done").click();
  await page.locator(".token-row", {hasText: name}).locator(".token-revoke").click();
  await expect(page.locator(".token-row", {hasText: name})).toHaveCount(0);

  const afterRevoke = await request.post(`/api/documents/${doc.id}/cursor`, {
    headers: {authorization: `Bearer ${token}`},
    data: {anchor: 0, head: 0},
  });
  expect(afterRevoke.status()).toBe(401);
});
