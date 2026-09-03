# live-md

A real-time collaborative **Markdown editor for people *and* AI agents**. Humans edit in
the browser; agents edit through a small SDK — both against the *same* live document, at
the same time, with edits merging automatically and never conflicting.

Every document is independently owned and privately shared (owner / editor / viewer), so
a workspace can hold many documents with different collaborators — human or agent — on
each.

## Why CRDTs (Yjs)

Each participant keeps a local replica of the document; edits are exchanged as small
binary operations and every replica **converges** to the same state regardless of order,
duplication, or offline gaps. There is no "last write wins" clobbering — two people (or an
agent and a person) typing in the same place both keep their edits, ordered
deterministically.

```
Browser  ─┐
Agent A  ─┼─▶  server Y.Doc  ─▶  broadcasts merged updates  ─▶  everyone converges
Agent B  ─┘        │
                   └─▶  SQLite (snapshot + append-only update log) for durability
```

The canonical content is Markdown stored in a Yjs `Y.Text`; the server never guesses
authorship — it stamps every edit with the authenticated principal.

## Features

- **Real-time multi-document editing** — open any document at `/documents/:id`; a
  per-document WebSocket room keeps edits from crossing between documents.
- **Humans and agents as equal collaborators** — the same document is editable from the
  browser and from the `AgentClient` SDK.
- **Per-document authorization** — global `admin`/`member` roles plus per-document
  `owner` / `editor` / `viewer` sharing. Documents are private by default; access is
  decided at a single choke point and returns **404 (not 403)** so ids never leak.
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
- **Durable & restart-safe** — SQLite snapshot + compacted update log; update submission is
  idempotent across restarts.

## Run

```bash
npm install
cp .env.example .env   # then fill in the values below
npm run dev
```

Open <http://localhost:3000>.

### Configuration (`.env`)

- **GitHub OAuth** (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`) — how
  humans sign in.
- **`ALLOWED_GITHUB`** — allowlist of GitHub logins/emails permitted to sign in. It **fails
  closed**: an empty allowlist admits no one. This app is built for a **closed circle** of
  mutually-known collaborators.
- **`ADMIN_GITHUB`** — allowlist (keyed on a trusted attribute) that bootstraps admins.
- **`DATA_DIR`** — where the SQLite database and file blobs live (default `data/`).

Agents authenticate with opaque bearer tokens instead of a session. Create one from the
browser's token panel (🔑), or from the host with `npm run mint-token -- --name "<agent>"`.

## API (overview)

Every `/api` route requires authentication — a human session cookie or an agent bearer
token — except `GET /api/me`. Access is decided per document; no access → 404.

- **Documents:** `GET /api/documents/:id/state` · `POST /api/documents/:id/sync` ·
  `GET`/`POST /api/documents/:id/updates` · cursors · `GET /api/documents/:id/history` ·
  `GET /api/documents/:id/export` · `GET/POST/DELETE /api/documents/:id/shares`.
- **Directory:** `GET /api/folders` · folder + document create/rename/move/delete ·
  `POST /api/folders/:id/import`.
- **Attachments:** `POST`/`GET /api/documents/:id/files` · `GET`/`DELETE /api/files/:id`.
- **Auth & tokens:** GitHub OAuth login/callback/logout · `GET /api/me` ·
  `GET`/`POST`/`DELETE /api/tokens` (human session).
- **Realtime:** `WS /ws?doc=<id>` — join one document's room for live document + cursor
  events.

## Agent SDK

`AgentClient` (`src/agent-client.ts`) is a small Node client: it targets one document,
keeps a local `Y.Doc`, and offers `insert` / `delete` / `replace`, cursor publishing,
attachments, comments, history, and Markdown import/export.

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

## Tech stack

TypeScript · [Yjs](https://github.com/yjs/yjs) CRDTs · Express 5 + `ws` · CodeMirror 6 ·
SQLite (`node:sqlite`) · GitHub OAuth sessions + opaque agent tokens · esbuild (client
bundle).

## Tests

```bash
npm run typecheck    # tsc --noEmit
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
  authz.ts           the can(principal, action, document) choke point
  auth.ts / human-auth.ts / allowlist.ts   agent tokens, sessions, sign-in allowlist
  directory.ts       folders + documents + per-document shares
  files.ts / blob-store.ts   attachments (content-addressed blobs)
  comments.ts        line-anchored comment threads (Yjs)
  activity.ts        durable activity/history log + server-minted update ids
  markdown-assets.ts / zip.ts   import/export link rewriting + store-only zip
  agent-client.ts    the AgentClient SDK
  client.ts          the browser app (bundled to public/app.js)
```
