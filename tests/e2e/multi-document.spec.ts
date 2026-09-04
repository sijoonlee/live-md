import {expect, test} from "@playwright/test";
import {callTool} from "./mcp-client";
import * as Y from "yjs";

// A base64 Yjs update that inserts `value` at the start of an empty document.

test("id-keyed documents hold independent content", async ({page, request}) => {
  await page.goto("/"); // establishes the signed-in session via storageState

  const root = (await (await request.get("/api/folders")).json()).folders[0];
  const create = async (name: string) =>
    (await request.post(`/api/folders/${root.id}/documents`, {data: {name}})).json();
  const suffix = Date.now();
  const docA = await create(`iso-a-${suffix}.md`);
  const docB = await create(`iso-b-${suffix}.md`);

  // Write only to document A, over MCP.
  const agentName = `iso-agent-${suffix}`;
  const write = await callTool(request, agentName, "append_document", {documentId: docA.id, content: "only in A"});
  expect(write.isError).toBe(false);

  const textOf = async (id: number) => {
    const state = await (await request.get(`/api/documents/${id}/state`)).json();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(state.update, "base64")));
    return doc.getText("content").toString();
  };
  // A has the content the agent wrote.
  expect(await textOf(docA.id)).toBe("only in A");
  // B is a separate room and a separate Y.Doc: the write to A must not reach it.
  const ownerState = await (await request.get(`/api/documents/${docB.id}/state`)).json();
  const bDoc = new Y.Doc();
  Y.applyUpdate(bDoc, new Uint8Array(Buffer.from(ownerState.update, "base64")));
  expect(bDoc.getText("content").toString()).toBe("");
});

test("a non-existent document id returns 404, not a leak", async ({page, request}) => {
  await page.goto("/");
  const missing = await request.get("/api/documents/99999999/state");
  expect(missing.status()).toBe(404);
});
