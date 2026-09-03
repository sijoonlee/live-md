# Plan: MCP server

## Goal

Let an agent that lives somewhere else — Claude Code in a terminal, primarily —
read and edit live-md documents directly, while a human edits the same document in
the browser and sees the changes arrive live.

This is the missing half of the product. Humans have a way into a document (the web
UI); agents do not, short of writing code against `AgentClient`. MCP is the
interface every agent host already speaks, so adding it makes "work on my design
doc" a thing the user simply asks for.

## Shape

Streamable HTTP MCP mounted on the existing Express app at `POST /api/mcp`. No new
process, no new port, no stdio child to supervise.

Authentication reuses what is already there, via the same resolution used by the
rest of `/api`:

- `AUTH_MODE=github` — `Authorization: Bearer agt_…`, an agent token minted by
  `npm run mint-token` or the browser token panel.
- `AUTH_MODE=none` — no header needed; an optional `X-Agent-Id` names the agent for
  attribution. See `plan-auth-resolver.md`.

Every tool call resolves a principal and goes through `can(principal, action,
document)`. An agent sees only documents shared with it; anything else 404s, so ids
never leak. No new authorization logic.

## Tools

Deliberately small. Resist growing this list until real use demands it.

| Tool | Args | Notes |
|---|---|---|
| `list_documents` | — | id, name, folder path for every document the principal can read |
| `read_document` | `documentId` | Markdown content plus a `version` marker |
| `edit_document` | `documentId`, `oldString`, `newString` | anchored replace |
| `append_document` | `documentId`, `content` | the common case, always safe |
| `add_comment` | `documentId`, `anchorText`, `body` | agent leaves a note instead of editing |

### Why anchored, not offset-based

`AgentClient` exposes `insert(index, text)` / `delete(index, len)`. That is the
wrong interface for an LLM: models are poor at character offsets, and by the time
one is computed the human may have typed three paragraphs above it, invalidating
it.

`edit_document` instead takes `oldString` / `newString` — the shape agents already
handle well — and resolves the anchor against the **current** `Y.Text` at apply
time, converting to a Yjs transaction only once the match is known. A human editing
elsewhere in the document cannot invalidate the edit.

Matching rules:

- exactly one match → apply
- zero matches → error: "anchor not found; re-read the document"
- more than one match → error: "anchor matches N times; include more surrounding context"

Never fuzzy-match, never trim to force a hit, never pick the closest candidate. An
agent given a soft match will confidently edit the wrong paragraph, and a crisp
error is something agents recover from correctly.

`read_document` returns a `version`; `edit_document` may pass it back, and a
mismatch is reported rather than silently applied over a changed document.

## Implementation

- `src/mcp.ts` — transport, session handling, tool dispatch.
- `src/mcp-tools.ts` — the five definitions plus their handlers.
- Handlers call the same document primitives the HTTP routes use (`getLiveDocument`,
  the comment helpers, the directory listing). Nothing bypasses `document.ts`, so
  edits persist, broadcast to open browsers, and land in the activity log exactly
  like any other edit.
- Attribution flows from the resolved principal; identity stays server-set.
- `agent-client.ts` remains, but becomes the internal SDK rather than the interface
  agents are expected to use.

Use the official TypeScript MCP SDK rather than hand-rolling the protocol; check
its current server/transport API when starting, since it has moved over time.

## Setup UX

A `GET /api/mcp/config` route (human session, or open in `AUTH_MODE=none`) returns
a ready-to-paste MCP client config block — URL, and token when one is required — so
connecting Claude Code is copy-paste rather than documentation.

## Tests

- Unit: anchor resolution (unique / missing / ambiguous), version mismatch,
  CRLF-vs-LF normalisation of the anchor before matching.
- Authorization: an agent principal cannot see or edit an unshared document, and
  gets 404 rather than 403.
- Integration: an `edit_document` call reaches an open WebSocket client, proving
  edits broadcast live to a browser.
- Concurrency: a human edit and an anchored agent edit in the same document
  converge and both survive.

## Out of scope

Agents creating or deleting documents; folder manipulation; attachments; resolving
comment threads. Add only on demand.

## Estimate

Roughly two days, including tests. Depends on `plan-auth-resolver.md` for the
principal-resolution seam.
