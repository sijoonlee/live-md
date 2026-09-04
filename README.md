# live-md (local-only)

A real-time collaborative **Markdown editor for you and your AI agents**, running on your
own machine. You edit in the browser (or in a VS Code tab); agents edit over **MCP** —
both against the *same* live document, at the same time, with edits merging automatically
and never conflicting.

**There is no authentication, no sharing, and no permission model.** Everything reachable
on the port is yours, which is why the server binds to `127.0.0.1` and refuses to start
anywhere else. For several people on a shared instance, use `main`.

The point is the concurrency. Ask an agent to work on a document while you are typing in
it, and both of you keep writing: no locking, no "reload to see changes", no copy-pasting
a document into a chat window and back.

## Why CRDTs (Yjs)

Each participant keeps a local replica of the document; edits are exchanged as small
binary operations and every replica **converges** to the same state regardless of order,
duplication, or offline gaps. There is no "last write wins" clobbering — two people (or an
agent and a person) typing in the same place both keep their edits, ordered
deterministically.

```
Browser / VS Code  ─┐
Agent over MCP     ─┼─▶  server Y.Doc  ─▶  broadcasts merged updates  ─▶  everyone converges
Agent over the SDK ─┘        │
                             └─▶  SQLite (snapshot + append-only update log) for durability
```

The canonical content is Markdown stored in a Yjs `Y.Text`; the server never guesses
authorship — it stamps every edit with the principal that made it.

## Features

- **Real-time multi-document editing** — open any document at `/documents/:id`; a
  per-document WebSocket room keeps edits from crossing between documents.
- **Agents as first-class collaborators** — an MCP server exposes every document to Claude
  Code and anything else that speaks MCP, with anchored (not offset-based) edits.
- **Comments** — line-anchored, CRDT-native comment threads that track edits (insert lines
  above and a comment moves with its line); stored in the document, so they sync and
  persist with it.
- **Attachments** — files belong to a document, inherit its access, render inline
  (images) or download, and cascade-delete with it.
- **Activity / history** — a durable, append-only log of every accepted edit with author,
  time, and a stable server-minted update id; browsable in a History panel and over the
  API.
- **Markdown import / export** — export a document as `.md`, or as a `.zip` bundle with its
  attachments (links rewritten); import either back into a new document.
- **Durable & restart-safe** — SQLite snapshot + compacted update log.

---

# Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:3000> and create a document. There is no sign-in step and nothing
to configure.

Because nothing authenticates, the server keeps to requests that actually came from this
machine: it **refuses to start** unless bound to `127.0.0.1`, and rejects requests carrying
a foreign `Origin` or a non-localhost `Host`. (Any web page you visit can otherwise reach
`localhost`, and there is no cookie standing in its way.)

## Connect an agent (MCP)

Documents are exposed over [MCP](https://modelcontextprotocol.io) at `POST /api/mcp`
(streamable HTTP), mounted on the same server and port. To add it to Claude Code:

```bash
claude mcp add --transport http live-md http://localhost:3000/api/mcp \
  --header "X-Agent-Id: claude-code"
```

Restart Claude Code, then just ask: *"add a section on rate limiting to my design doc."*
Edits appear in your browser live, with no reload — while you keep typing.

`X-Agent-Id` is unverified — nothing here verifies anything — and exists only so the
history log can say which agent wrote what. `GET /api/mcp/config` returns a ready-to-paste config block if
you would rather copy one.

### Tools

| Tool | |
| --- | --- |
| `list_documents` | documents this agent can read, with folder paths |
| `create_document` | create one, optionally with initial content |
| `rename_document` | rename in place |
| `move_document` | move into another directory |
| `read_document` | Markdown content plus a `version` for optimistic concurrency |
| `edit_document` | replace an exact passage (`oldString` → `newString`) |
| `append_document` | append to the end |
| `add_comment` | comment on a passage instead of editing it |
| `list_comments` | a document's comment threads |
| `reply_to_comment` | answer a question left in a thread |
| `resolve_comment` | mark a thread resolved, or reopen it |
| `delete_comment` | remove a comment (a thread with replies is tombstoned) |
| `list_attachments` | a document's files, with the reference to link to one |
| `attach_file` | attach a local file; returns Markdown ready to insert |
| `delete_attachment` | remove an attachment |
| `export_document` | write `.md`, or a `.zip` bundle with attachments |
| `import_document` | create a document from a local `.md` or `.zip` |
| `list_directories` | every directory with its path, for resolving a name to an id |
| `create_directory` | create one, at the root or under a parent |
| `rename_directory` | rename in place |
| `move_directory` | move one under another, contents included |

Files move by **path**, not as base64 in a tool argument: the agent and the server share
a filesystem here, so routing megabytes through a model's context to move a file it can
already see would be absurd.

Edits are **anchored, not offset-based**. Models are poor at character offsets, and an
offset computed a moment ago may already be stale because you typed above it. `oldString`
is instead resolved against the document's *current* content at the moment of the edit, so
your typing elsewhere never invalidates it. An anchor matching zero or several places is
refused with an error telling the agent to re-read or add context — never a fuzzy match,
which would confidently rewrite the wrong paragraph.

## Use it inside VS Code

`vscode-extension/` puts a document in a VS Code tab, beside your code and your agent
terminal.

```bash
./vscode-extension/install.sh   # then reload the VS Code window
```

Run **live-md: Open** from the command palette. If nothing is answering at `liveMd.url`
(`http://localhost:3000` by default), the extension starts the server for you — so a cold
start is one command — and stops it again when the window closes. A server you are already
running is detected and left alone, never duplicated on its port. To try it without installing, press <kbd>F5</kbd>
from the repository root and run the same command in the new window; to uninstall,
`./vscode-extension/install.sh --remove`.

| Setting | |
| --- | --- |
| `liveMd.url` | server to connect to (default `http://localhost:3000`) |
| `liveMd.autoStart` | start the server when nothing is answering (default `true`) |
| `liveMd.serverPath` | where the repository is; defaults to whichever open workspace folder is the live-md project |
| `liveMd.startCommand` | how to start it (default `npm run dev`) |

Commands: **live-md: Open**, **Reload**, **Start Server**, **Stop Server**.

The extension has no dependencies or toolchain of its own — its `package.json` is a VS Code
manifest and the root project builds it (`npm run build:extension`), so there is no second
`npm install`, and the install script copies it where VS Code looks rather than packaging
a `.vsix`.

It exists for one reason: **`retainContextWhenHidden`**. VS Code's built-in Simple Browser
shows the same page with no code at all, but its webview is torn down when the tab is
hidden and rebuilt when shown — so switching to the terminal and back reloads the page and
loses your caret, selection and scroll position mid-edit. This panel keeps its context
alive instead.

There is no bridge to a VS Code `TextDocument` and no second replica of the text: live-md
documents are not files, and the webview runs the existing browser client unchanged.

---

# Configuration (`.env`)

| Variable | |
| --- | --- |
| `DATA_DIR` | where the SQLite database and file blobs live (default `data/`) |
| `PORT` | port to listen on (default 3000); the host is always `127.0.0.1` |

---

# API (overview)

No route requires authentication. Requests that look like they came from another site are
refused by the loopback guard; everything else is allowed.

- **Documents:** `GET /api/documents/:id/state` ·
  `GET /api/documents/:id/history` · `GET /api/documents/:id/export`.
- **Directory:** `GET /api/folders` · folder + document create/rename/move/delete ·
  `POST /api/folders/:id/import`.
- **Attachments:** `POST`/`GET /api/documents/:id/files` · `GET`/`DELETE /api/files/:id`.
- **MCP:** `POST /api/mcp` · `GET /api/mcp/config`.
- **Realtime:** `WS /ws?doc=<id>` — join one document's room for live document + cursor
  events.

## Tech stack

TypeScript · [Yjs](https://github.com/yjs/yjs) CRDTs · Express 5 + `ws` · CodeMirror 6 ·
SQLite (`node:sqlite`) · [MCP TypeScript SDK](https://modelcontextprotocol.io) · esbuild
(client and extension bundles).

## Tests

```bash
npm run typecheck    # tsc --noEmit, server + extension
npm run test:unit    # node:test unit suite
npm run test:e2e     # Playwright end-to-end (starts a disposable server)
```

## Project layout

```
src/
  server.ts          HTTP + WebSocket server and all routes
  document.ts        one live Y.Doc: apply/persist updates, cursors, idempotency
  document-registry.ts  per-document live instances with idle eviction
  persistence.ts     SQLite snapshot + append-only update log (compaction)
  author.ts / loopback-guard.ts   edit attribution + the local-only guard
  directory.ts       folders + documents
  files.ts / blob-store.ts   attachments (content-addressed blobs)
  comments.ts        line-anchored comment threads (Yjs)
  activity.ts        durable activity/history log + server-minted update ids
  markdown-assets.ts / zip.ts   link rewriting + store-only zip
  export-import.ts   Markdown/zip export and import, shared by HTTP and MCP
  mcp.ts / mcp-tools.ts   the MCP server: transport, and the anchored document tools
  client.ts          the browser app (bundled to public/app.js)
vscode-extension/    VS Code webview panel hosting the browser client
```
