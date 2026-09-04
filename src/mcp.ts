import express from "express";
import {z} from "zod";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ToolError,
  addCommentTool,
  appendDocumentTool,
  attachFileTool,
  deleteAttachmentTool,
  deleteCommentTool,
  editDocumentTool,
  exportDocumentTool,
  importDocumentTool,
  listAttachmentsTool,
  listCommentsTool,
  listDocumentsTool,
  readDocumentTool,
  replyToCommentTool,
  resolveCommentTool,
  type AcceptUpdate,
} from "./mcp-tools.js";

// The MCP surface (M22). Humans reach a document through the browser; this is how
// an agent that lives elsewhere — Claude Code in a terminal, typically — reaches
// the same one, so "work on my design doc" needs no copy-paste and no bespoke
// integration. Edits arrive live in whatever browser has the document open.
//
// Streamable HTTP on the existing Express app rather than a stdio child process:
// one server, one port, nothing extra to supervise.

// Stateless: every POST builds its own server and transport. MCP sessions would buy
// resumable SSE we have no use for here, at the price of state to keep in step.
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

export const createMcpServer = (author: string, acceptUpdate: AcceptUpdate): McpServer => {
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
    async () => run(() => listDocumentsTool()),
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
    async ({documentId: id}) => run(() => readDocumentTool(id)),
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
    async (args) => run(() => editDocumentTool(author, acceptUpdate, args)),
  );

  server.registerTool(
    "append_document",
    {
      title: "Append to document",
      description: "Append Markdown to the end of a document. Prefer this over edit_document when adding a new section.",
      inputSchema: {documentId, content: z.string().min(1).describe("Markdown to append")},
    },
    async (args) => run(() => appendDocumentTool(author, acceptUpdate, args)),
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
    async (args) => run(() => addCommentTool(author, acceptUpdate, args)),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description: "List a document's comment threads, including any the person has left for this agent.",
      inputSchema: {documentId},
      annotations: {readOnlyHint: true},
    },
    async ({documentId: id}) => run(() => listCommentsTool(id)),
  );

  // --- comment threads ----------------------------------------------------

  server.registerTool(
    "reply_to_comment",
    {
      title: "Reply to a comment",
      description: "Reply in an existing comment thread — how to answer a question the person left for you.",
      inputSchema: {
        documentId,
        commentId: z.string().min(1).describe("thread or comment id, from list_comments"),
        body: z.string().min(1).describe("the reply"),
      },
    },
    async (args) => run(() => replyToCommentTool(author, acceptUpdate, args)),
  );

  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve a comment thread",
      description: "Mark a thread resolved once you have acted on it (or reopen it with resolved: false).",
      inputSchema: {
        documentId,
        commentId: z.string().min(1).describe("the thread's first comment id"),
        resolved: z.boolean().optional().describe("false reopens the thread; defaults to true"),
      },
    },
    async (args) => run(() => resolveCommentTool(author, acceptUpdate, args)),
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete a comment",
      description:
        "Delete a comment you left. A thread with replies is kept as \"[deleted]\" so the conversation stays readable.",
      inputSchema: {documentId, commentId: z.string().min(1).describe("comment id, from list_comments")},
    },
    async (args) => run(() => deleteCommentTool(author, acceptUpdate, args)),
  );

  // --- attachments --------------------------------------------------------

  server.registerTool(
    "list_attachments",
    {
      title: "List attachments",
      description: "List a document's attached files, with the reference to use when linking to one.",
      inputSchema: {documentId},
      annotations: {readOnlyHint: true},
    },
    async ({documentId: id}) => run(() => listAttachmentsTool(id)),
  );

  server.registerTool(
    "attach_file",
    {
      title: "Attach a file",
      description:
        "Attach a local file to a document. Returns Markdown ready to insert with edit_document — " +
        "attaching does not put a link in the text by itself.",
      inputSchema: {
        documentId,
        path: z.string().min(1).describe("path to the file on this machine"),
        filename: z.string().optional().describe("name to store it under; defaults to the file's own name"),
      },
    },
    async (args) => run(() => attachFileTool(author, args)),
  );

  server.registerTool(
    "delete_attachment",
    {
      title: "Delete an attachment",
      description: "Permanently delete an attachment. Links to it in the document are left as they are.",
      inputSchema: {fileId: z.number().int().positive().describe("id from list_attachments")},
    },
    async ({fileId}) => run(() => deleteAttachmentTool(fileId)),
  );

  // --- import / export ----------------------------------------------------

  server.registerTool(
    "export_document",
    {
      title: "Export a document",
      description:
        "Write a document to a file as Markdown, or as a .zip bundle with its attachments when it " +
        "references any (format: \"md\" forces plain Markdown). Give a directory to use the document's own name.",
      inputSchema: {
        documentId,
        path: z.string().min(1).describe("file to write, or a directory to write into"),
        format: z.literal("md").optional().describe("force plain Markdown instead of a bundle"),
      },
    },
    async (args) => run(() => exportDocumentTool(args)),
  );

  server.registerTool(
    "import_document",
    {
      title: "Import a document",
      description:
        "Create a document from a local .md file or a .zip bundle (Markdown plus an assets/ folder). " +
        "Bundled assets become attachments and their links are rewritten.",
      inputSchema: {
        path: z.string().min(1).describe("path to a .md or .zip file on this machine"),
        folderId: z.number().int().positive().optional().describe("folder to create it in; defaults to the root"),
        name: z.string().optional().describe("document name; defaults to the file's name"),
      },
    },
    async (args) => run(() => importDocumentTool(author, acceptUpdate, args)),
  );

  return server;
};

// Express handler for POST /api/mcp. There is nothing to authenticate: the author
// is a label the agent supplies for the history log.
export const mcpHandler =
  (acceptUpdate: AcceptUpdate, authorFor: (req: express.Request) => string) =>
  async (req: express.Request, res: express.Response) => {
    const server = createMcpServer(authorFor(req), acceptUpdate);
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
