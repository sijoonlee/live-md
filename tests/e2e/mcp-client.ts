import type {APIRequestContext} from "@playwright/test";

// A minimal MCP client for the e2e suite. Streamable HTTP in stateless mode is a
// plain POST per JSON-RPC message, so there is no session to establish — which is
// also why tests can call a tool without an initialize handshake.
//
// Tests drive the server through this rather than through an SDK, because MCP is
// how agents actually reach a document here.

const HEADERS = {"content-type": "application/json", accept: "application/json, text/event-stream"};

export type ToolResult = {text: string; isError: boolean};

export async function callTool(
  request: APIRequestContext,
  agentId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const response = await request.post("/api/mcp", {
    headers: {...HEADERS, "x-agent-id": agentId},
    data: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}},
  });
  const body = await response.json();
  return {text: body.result.content[0].text, isError: !!body.result.isError};
}

// Same, for the tools that return JSON. Throws on a tool error so a test fails at
// the call rather than on a confusing assertion further down.
export async function callToolJson<T>(
  request: APIRequestContext,
  agentId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await callTool(request, agentId, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.text}`);
  return JSON.parse(result.text) as T;
}
