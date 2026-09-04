# live-md

A real-time collaborative **Markdown editor for people *and* AI agents**. You edit in the
browser (or in a VS Code tab); agents edit over **MCP** — both against the *same* live
document, at the same time, with edits merging automatically and never conflicting.

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
- **Agents as first-class collaborators** — an MCP server exposes documents to Claude Code
  and anything else that speaks MCP, with anchored (not offset-based) edits.
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
- **Optional authentication** — run it open on your own machine, or with GitHub sign-in and
  per-document sharing for a group.
- **Durable & restart-safe** — SQLite snapshot + compacted update log; update submission is
  idempotent across restarts.

---

# Quick start (local, no sign-in)

The fastest way to run it: one person, one machine, no OAuth app to register.

```bash
npm install
echo "AUTH_MODE=none" >> .env   # the only setting this mode needs
npm run dev
```

Open <http://localhost:3000> and create a document. There is no sign-in step.

`AUTH_MODE=none` treats every caller as a single local admin. It is only safe on the
loopback interface, and the server enforces that rather than trusting you to remember: it
**refuses to start** unless bound to `127.0.0.1`, and rejects requests carrying a foreign
`Origin` or a non-localhost `Host`. (Any web page you visit can otherwise reach
`localhost`, and with no sign-in there is no cookie standing in its way.)

For a shared or hosted instance, see [Multi-user setup](#multi-user-setup) below.

## Connect an agent (MCP)

Documents are exposed over [MCP](https://modelcontextprotocol.io) at `POST /api/mcp`
(streamable HTTP), mounted on the same server and port. To add it to Claude Code:

```bash
claude mcp add --transport http live-md http://localhost:3000/api/mcp \
  --header "X-Agent-Id: claude-code"
```

Restart Claude Code, then just ask: *"add a section on rate limiting to my design doc."*
Edits appear in your browser live, with no reload — while you keep typing.

`X-Agent-Id` is unverified under `AUTH_MODE=none` and exists only so the history log can
say which agent wrote what. `GET /api/mcp/config` returns a ready-to-paste config block if
you would rather copy one.

### Tools

| Tool | |
| --- | --- |
| `list_documents` | documents this agent can read, with folder paths |
| `read_document` | Markdown content plus a `version` for optimistic concurrency |
| `edit_document` | replace an exact passage (`oldString` → `newString`) |
| `append_document` | append to the end |
| `add_comment` | comment on a passage instead of editing it |
| `list_comments` | a document's comment threads |

Edits are **anchored, not offset-based**. Models are poor at character offsets, and an
offset computed a moment ago may already be stale because you typed above it. `oldString`
is instead resolved against the document's *current* content at the moment of the edit, so
your typing elsewhere never invalidates it. An anchor matching zero or several places is
refused with an error telling the agent to re-read or add context — never a fuzzy match,
which would confidently rewrite the wrong paragraph.

Every tool call goes through the same authorization choke point as the HTTP API, so under
a multi-user setup an agent sees only documents shared with it and anything else 404s.

## Use it inside VS Code

`vscode-extension/` puts a document in a VS Code tab, beside your code and your agent
terminal.

```bash
./vscode-extension/install.sh   # then reload the VS Code window
```

Run **live-md: Open** from the command palette. `liveMd.url` points it at the server
(`http://localhost:3000` by default). To try it without installing, press <kbd>F5</kbd>
from the repository root and run the same command in the new window; to uninstall,
`./vscode-extension/install.sh --remove`.

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

# Multi-user setup

Set `AUTH_MODE=github` (the default) to require sign-in. People sign in with GitHub and
hold a server-side session; agents present opaque bearer tokens. Documents are private by
default and shared explicitly.

Register a GitHub OAuth app, then fill in `.env` (see `.env.example`):

```bash
GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
GITHUB_CALLBACK_URL=http://localhost:3000/auth/callback
ALLOWED_GITHUB=your-github-login    # fails closed: empty admits nobody
ADMIN_GITHUB=your-github-login
```

Mint an agent token from the browser's token panel (🔑) or with
`npm run mint-token -- --name "<agent>"`, share a document with that agent, and point the
agent at the server with `--header "Authorization: Bearer agt_…"` instead of `X-Agent-Id`.

**Authorization model.** Global `admin` / `member` roles plus per-document `owner` /
`editor` / `viewer` sharing. Access is decided at a single `can(principal, action,
document)` choke point and returns **404, not 403**, so document ids never leak.

## Configuration (`.env`)

| Variable | |
| --- | --- |
| `AUTH_MODE` | `github` (default) or `none`. Anything unrecognised means `github`, so a deployment that fat-fingers it comes up secured rather than open. |
| `DATA_DIR` | where the SQLite database and file blobs live (default `data/`) |
| `PORT` / `HOST` | listen address; `AUTH_MODE=none` refuses any non-loopback `HOST` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` | GitHub OAuth app |
| `ALLOWED_GITHUB` | logins/emails permitted to sign in; **fails closed** |
| `ADMIN_GITHUB` | logins/emails granted the global `admin` role |

The GitHub variables are unnecessary under `AUTH_MODE=none`.

---

# API (overview)

Every `/api` route requires authentication except `GET /api/me` — a session cookie or an
agent bearer token, or nothing at all under `AUTH_MODE=none`. Access is decided per
document; no access → 404.

- **Documents:** `GET /api/documents/:id/state` · `POST /api/documents/:id/sync` ·
  `GET`/`POST /api/documents/:id/updates` · cursors · `GET /api/documents/:id/history` ·
  `GET /api/documents/:id/export` · `GET/POST/DELETE /api/documents/:id/shares`.
- **Directory:** `GET /api/folders` · folder + document create/rename/move/delete ·
  `POST /api/folders/:id/import`.
- **Attachments:** `POST`/`GET /api/documents/:id/files` · `GET`/`DELETE /api/files/:id`.
- **MCP:** `POST /api/mcp` · `GET /api/mcp/config`.
- **Auth & tokens:** GitHub OAuth login/callback/logout · `GET /api/me` ·
  `GET`/`POST`/`DELETE /api/tokens` (human session).
- **Realtime:** `WS /ws?doc=<id>` — join one document's room for live document + cursor
  events.

## Agent SDK

Prefer MCP for agents that speak it. `AgentClient` (`src/agent-client.ts`) is a small Node
client for those that do not: it targets one document, keeps a local `Y.Doc`, and offers
`insert` / `delete` / `replace`, cursor publishing, attachments, comments, history, and
Markdown import/export.

```ts
import {AgentClient} from "./src/agent-client.js";

const agent = new AgentClient({
  baseUrl: "http://localhost:3000",
  agentId: "agent-researcher",  // a label; identity is server-set from the token
  token: "agt_…",               // an agent token
  documentId: 42,               // the document to edit (must be shared with this agent)
});

await agent.load();
await agent.insert(agent.text.length, "\nNew research.", {reason: "summary", sourceRun: "run-183"});
```

Note its offset-based API — the reason the MCP tools deliberately do not expose one.

## Tech stack

TypeScript · [Yjs](https://github.com/yjs/yjs) CRDTs · Express 5 + `ws` · CodeMirror 6 ·
SQLite (`node:sqlite`) · [MCP TypeScript SDK](https://modelcontextprotocol.io) · GitHub
OAuth sessions + opaque agent tokens · esbuild (client and extension bundles).

## Tests

```bash
npm run typecheck    # tsc --noEmit, server + extension
npm run test:unit    # node:test unit suite
npm run test:e2e     # Playwright end-to-end (starts a disposable server)
```

The e2e server pins `AUTH_MODE=github`: it exercises the authenticated surface, and the
server reads `.env`, so a local `AUTH_MODE=none` would otherwise fail every
"rejects an unauthenticated request" test.

## Project layout

```
src/
  server.ts          HTTP + WebSocket server and all routes
  document.ts        one live Y.Doc: apply/persist updates, cursors, idempotency
  document-registry.ts  per-document live instances with idle eviction
  persistence.ts     SQLite snapshot + append-only update log (compaction)
  authz.ts           the can(principal, action, document) choke point
  auth.ts / human-auth.ts / allowlist.ts   agent tokens, sessions, sign-in allowlist
  auth-mode.ts / loopback-guard.ts   optional auth (AUTH_MODE=none) + its loopback guard
  directory.ts       folders + documents + per-document shares
  files.ts / blob-store.ts   attachments (content-addressed blobs)
  comments.ts        line-anchored comment threads (Yjs)
  activity.ts        durable activity/history log + server-minted update ids
  markdown-assets.ts / zip.ts   import/export link rewriting + store-only zip
  mcp.ts / mcp-tools.ts   the MCP server: transport, and the anchored document tools
  agent-client.ts    the AgentClient SDK
  client.ts          the browser app (bundled to public/app.js)
vscode-extension/    VS Code webview panel hosting the browser client
```
