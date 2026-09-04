import {expect, test, type Page} from "@playwright/test";
import {callTool} from "./mcp-client";

// The product claim, end to end: a person has a document open in the browser, an
// agent works on it from somewhere else entirely (over MCP — in practice Claude Code
// in a terminal), and the edit shows up in front of the person without a reload.

// Create a document. The agent needs no credential — it names itself for the
// history log and that is all.
async function setup(page: Page, agentName: string) {
  await page.goto("/");
  const documentId = await page.evaluate(async () => {
    const root = (await (await fetch("/api/folders")).json()).folders[0];
    const document = await (await fetch(`/api/folders/${root.id}/documents`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name: `mcp-${Date.now()}.md`}),
    })).json();
    return document.id as number;
  });
  return {documentId, token: agentName};
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

test("a document that does not exist is reported as missing", async ({page, request}) => {
  const {documentId, token} = await setup(page, `mcp-missing-doc-${Date.now()}`);
  const read = await callTool(request, token, "read_document", {documentId: documentId + 10_000});
  expect(read.isError).toBe(true);
  expect(read.text).toContain("not found");
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

// The same caret guarantee as for a second browser, but exercised through the MCP
// path an agent actually uses: a person parks the caret mid-document, the agent
// inserts well above it, and the person's next keystroke must still land where they
// left off. Mid-document deliberately — a caret at the very end survives even a
// whole-document replace, so testing there proves nothing.
test("an agent's MCP edit above the caret does not move it", async ({page, request}) => {
  const {documentId, token} = await setup(page, `mcp-caret-${Date.now()}`);
  await page.goto(`/documents/${documentId}`);
  const editor = page.getByTestId("document").locator(".cm-content");
  await expect(editor).toBeEditable();

  await editor.fill("alpha\nbravo\ncharlie\ndelta\necho");
  await expect(editor).toContainText("echo");

  // Caret parked at the end of a middle line.
  await page.getByText("charlie").click();
  await page.keyboard.press("End");

  const edited = await callTool(request, token, "edit_document", {
    documentId,
    oldString: "alpha",
    newString: "AGENT-INSERTED-LINE-ONE\nAGENT-INSERTED-LINE-TWO\nalpha",
  });
  expect(edited.isError).toBe(false);
  await expect(editor).toContainText("AGENT-INSERTED-LINE-TWO");

  await page.keyboard.type("!");
  await expect(editor).toContainText("charlie!");
  await expect(editor).not.toContainText("!AGENT-INSERTED-LINE-ONE");
});
