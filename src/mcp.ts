import express from "express";
import {z} from "zod";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {Principal} from "./auth.js";
import {
  ToolError,
  addCommentTool,
  appendDocumentTool,
  editDocumentTool,
  listCommentsTool,
  listDocumentsTool,
  readDocumentTool,
  type AcceptUpdate,
} from "./mcp-tools.js";

// The MCP surface (M22). Humans reach a document through the browser; this is how
// an agent that lives elsewhere — Claude Code in a terminal, typically — reaches
// the same one, so "work on my design doc" needs no copy-paste and no bespoke
// integration. Edits arrive live in whatever browser has the document open.
//
// Streamable HTTP on the existing Express app rather than a stdio child process:
// one server, one port, nothing extra to supervise.

// Stateless: every POST builds its own server and transport, so the principal is
// resolved per request and nothing is cached across calls that a change in
// sharing should invalidate. MCP sessions would buy resumable SSE we have no use
// for here, at the price of that staleness.
const STATELESS = {sessionIdGenerator: undefined, enableJsonResponse: true} as const;

// Tool results are JSON in a text block: the shape every MCP client renders, and
// what agents parse most reliably.
const ok = (value: unknown) => ({content: [{type: "text" as const, text: JSON.stringify(value, null, 2)}]});

// A failed tool call is information the agent acts on, not a transport failure —
// an unfound anchor should come back as "re-read and retry", which is a normal
// result with isError set, not a JSON-RPC error.
const failed = (error: unknown) => ({
  content: [{type: "text" as const, text: error instanceof Error ? error.message : String(error)}],
  isError: true,
});

const run = <T>(work: () => T) => {
  try {
    return ok(work());
  } catch (error) {
    if (error instanceof ToolError) return failed(error);
    // Anything unexpected is still reported to the agent, but logged here so it
    // does not vanish into a tool result nobody reads.
    console.error("[mcp] tool failed", error);
    return failed(error);
  }
};

const documentId = z.number().int().positive().describe("id of the document, from list_documents");

export const createMcpServer = (principal: Principal, acceptUpdate: AcceptUpdate): McpServer => {
  const server = new McpServer(
    {name: "live-md", version: "1.0.0"},
    {instructions:
      "Collaborative Markdown documents that a person may be editing at the same time. " +
      "Call read_document before editing so edits target current content, and prefer " +
      "edit_document/append_document over rewriting a whole document.",
    },
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description: "List the documents this agent can read, with their ids and folder paths.",
      inputSchema: {},
      annotations: {readOnlyHint: true},
    },
    async () => run(() => listDocumentsTool(principal)),
  );

  server.registerTool(
    "read_document",
    {
      title: "Read document",
      description:
        "Read a document's Markdown content. Also returns a version number that edit_document " +
        "can be given to detect the document changing in between.",
      inputSchema: {documentId},
      annotations: {readOnlyHint: true},
    },
    async ({documentId: id}) => run(() => readDocumentTool(principal, id)),
  );

  server.registerTool(
    "edit_document",
    {
      title: "Edit document",
      description:
        "Replace an exact passage of a document. oldString must appear exactly once — include " +
        "surrounding context to make it unique. The passage is located in the document's current " +
        "content at the moment of the edit, so a person editing elsewhere will not invalidate it.",
      inputSchema: {
        documentId,
        oldString: z.string().min(1).describe("exact text to replace; must match exactly once"),
        newString: z.string().describe("replacement text; empty string deletes the passage"),
        expectedVersion: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("version from read_document; the edit is refused if the document has changed since"),
      },
    },
    async (args) => run(() => editDocumentTool(principal, acceptUpdate, args)),
  );

  server.registerTool(
    "append_document",
    {
      title: "Append to document",
      description: "Append Markdown to the end of a document. Prefer this over edit_document when adding a new section.",
      inputSchema: {documentId, content: z.string().min(1).describe("Markdown to append")},
    },
    async (args) => run(() => appendDocumentTool(principal, acceptUpdate, args)),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Comment on a passage",
      description:
        "Leave a comment anchored to a passage, instead of editing it. Use this to raise a question " +
        "or flag something for the person rather than changing their text.",
      inputSchema: {
        documentId,
        anchorText: z.string().min(1).describe("exact passage to comment on; must match exactly once"),
        body: z.string().min(1).describe("the comment"),
      },
    },
    async (args) => run(() => addCommentTool(principal, acceptUpdate, args)),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description: "List a document's comment threads, including any the person has left for this agent.",
      inputSchema: {documentId},
      annotations: {readOnlyHint: true},
    },
    async ({documentId: id}) => run(() => listCommentsTool(principal, id)),
  );

  return server;
};

// Express handler for POST /api/mcp. The caller has already been authenticated by
// the /api guard, so `principal` is whoever the request resolved to and every tool
// re-checks access per document.
export const mcpHandler =
  (acceptUpdate: AcceptUpdate, principalFor: (req: express.Request) => Principal | undefined) =>
  async (req: express.Request, res: express.Response) => {
    const principal = principalFor(req);
    if (!principal) return res.status(401).json({error: "authentication required"});

    const server = createMcpServer(principal, acceptUpdate);
    const transport = new StreamableHTTPServerTransport(STATELESS);
    // Stateless mode builds both per request, so both are disposed with it —
    // otherwise each call would leak a server and its transport.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[mcp] request failed", error);
      if (!res.headersSent) res.status(500).json({error: "MCP request failed"});
    }
  };
