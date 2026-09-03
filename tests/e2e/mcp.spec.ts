import {expect, test, type Page, type APIRequestContext} from "@playwright/test";

// The product claim, end to end: a person has a document open in the browser, an
// agent works on it from somewhere else entirely (here, over MCP with an agent
// token — in practice Claude Code in a terminal), and the edit shows up in front of
// the person without a reload.

const MCP_HEADERS = {"content-type": "application/json", accept: "application/json, text/event-stream"};

// Minimal MCP client: initialize, then call a tool. Streamable HTTP in stateless
// mode is a plain POST per JSON-RPC message, so no session plumbing is needed.
async function callTool(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{text: string; isError: boolean}> {
  const headers = {...MCP_HEADERS, authorization: `Bearer ${token}`};
  await request.post("/api/mcp", {
    headers,
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "e2e", version: "1"}},
    },
  });
  const response = await request.post("/api/mcp", {
    headers,
    data: {jsonrpc: "2.0", id: 2, method: "tools/call", params: {name, arguments: args}},
  });
  const body = await response.json();
  return {text: body.result.content[0].text, isError: !!body.result.isError};
}

// Create a document, mint an agent token, and share the document with that agent.
async function setup(page: Page, agentName: string) {
  await page.goto("/");
  return page.evaluate(async (name) => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    const document = await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: `mcp-${Date.now()}.md`}),
    })).json();
    const {token} = await (await fetch("/api/tokens", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name}),
    })).json();
    await fetch(`/api/documents/${document.id}/shares`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({agentName: name, level: "editor"}),
    });
    return {documentId: document.id as number, token: token as string};
  }, agentName);
}

test("an agent's MCP edit appears live in the browser the person is editing in", async ({page, request}) => {
  const {documentId, token} = await setup(page, `mcp-live-${Date.now()}`);
  await page.goto(`/documents/${documentId}`);
  const editor = page.getByTestId("document").locator(".cm-content");
  await expect(editor).toBeEditable();

  await editor.fill("# Spec\n\nWritten by the person.\n");
  await expect(editor).toContainText("Written by the person.");

  const appended = await callTool(request, token, "append_document", {
    documentId,
    content: "\n## Added by the agent\n",
  });
  expect(appended.isError).toBe(false);

  // No reload: the edit arrives over the document's WebSocket room.
  await expect(editor).toContainText("Added by the agent");
  await expect(editor).toContainText("Written by the person.");
});

test("an anchored edit lands correctly even though the person changed the text above it", async ({page, request}) => {
  const {documentId, token} = await setup(page, `mcp-anchor-${Date.now()}`);
  await page.goto(`/documents/${documentId}`);
  const editor = page.getByTestId("document").locator(".cm-content");
  await expect(editor).toBeEditable();

  await editor.fill("## Intro\n\nIntro text.\n\n## Details\n\nDetail text.\n");
  await expect(editor).toContainText("Detail text.");

  // The person expands the intro — everything below it shifts.
  await editor.fill("## Intro\n\nIntro text, now considerably longer than before.\n\n## Details\n\nDetail text.\n");
  await expect(editor).toContainText("considerably longer");

  // The agent named its target by content, so the shift is irrelevant.
  const edited = await callTool(request, token, "edit_document", {
    documentId,
    oldString: "Detail text.",
    newString: "Detail text, filled in by the agent.",
  });
  expect(edited.isError).toBe(false);

  await expect(editor).toContainText("filled in by the agent");
  await expect(editor).toContainText("considerably longer");
});

test("an agent may not touch a document it was not shared, and cannot tell it exists", async ({page, request}) => {
  const {token} = await setup(page, `mcp-stranger-${Date.now()}`);
  // A second document, never shared with that agent.
  const secret = await page.evaluate(async () => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    return (await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: `secret-${Date.now()}.md`}),
    })).json()) as {id: number};
  });

  const read = await callTool(request, token, "read_document", {documentId: secret.id});
  expect(read.isError).toBe(true);
  expect(read.text).toContain("not found");

  // Parse the ids rather than string-matching: a document id can appear
  // incidentally inside another document's timestamped name.
  const listed = await callTool(request, token, "list_documents", {});
  const visibleIds = (JSON.parse(listed.text) as {documentId: number}[]).map((entry) => entry.documentId);
  expect(visibleIds).not.toContain(secret.id);
});

test("a missing anchor is reported as a recoverable error, not a silent no-op", async ({page, request}) => {
  const {documentId, token} = await setup(page, `mcp-missing-${Date.now()}`);
  await callTool(request, token, "append_document", {documentId, content: "some content\n"});

  const result = await callTool(request, token, "edit_document", {
    documentId,
    oldString: "text that is not in the document",
    newString: "replacement",
  });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("Re-read the document");

  const after = await callTool(request, token, "read_document", {documentId});
  expect(after.text).toContain("some content");
  expect(after.text).not.toContain("replacement");
});
