# Plan: optional auth (`AUTH_MODE=none`) + loopback guardrail

## Goal

Make the authentication layer optional so live-md can run as a single-user local
app — no GitHub OAuth app, no sign-in, no agent tokens — while a deployed instance
keeps exactly the behaviour it has today.

Motivating setup: VS Code with the live-md web UI in a Simple Browser tab and
Claude Code in the terminal below, both working the same document. Sign-in is pure
friction there, and OAuth redirects inside a sandboxed webview are unreliable.

## Principle: swap authentication, never authorization

`authz.ts`'s `can(principal, action, document)` stays the single choke point, and
every route keeps receiving a real `Principal`. Only the step that *resolves* a
request to a principal changes. No `if (authDisabled)` branches in route handlers.

## Design

New `src/auth-mode.ts`:

```ts
export type AuthMode = "github" | "none";
export const authMode: AuthMode = process.env.AUTH_MODE === "none" ? "none" : "github";
```

Default is `github`, so a deployment that forgets the variable comes up secured
rather than open.

With `AUTH_MODE=none`, a request resolves to one of:

- **Local human** — a singleton `human` principal (`display_name: "local"`,
  `role: "admin"`), created on first use and reused thereafter. Admin means it sees
  every document without any share rows, which is what a single-user install wants.
- **Self-declared agent** — a request carrying `X-Agent-Id: <name>` resolves to the
  agent principal of that name, created on demand. Unverified by design: there is
  nothing to protect locally, and it keeps `activity.ts` attribution meaningful, so
  history still shows which agent wrote what.

### Touch points (all in `server.ts` unless noted)

| Site | Change with `AUTH_MODE=none` |
|---|---|
| `sessionPrincipal` | return the local principal instead of reading the `sid` cookie |
| `principalFromRequest` | bearer token, else `X-Agent-Id`, else local principal |
| `authedHuman` | return the local principal (never 401) |
| `authedPrincipal` | `X-Agent-Id` agent, else local principal |
| WebSocket handshake (`getSessionPrincipal(...)`) | local principal |
| `GET /api/me` | report the local user, plus `authMode` so the client can hide sign-in UI |
| `/auth/login`, `/auth/callback`, `/auth/logout` | not registered |

Keeping the change inside these five resolution sites means `authz.ts`,
`directory.ts`, shares, comments, files and activity are untouched.

### Client

`client.ts` reads `authMode` from `/api/me` and hides the sign-in / sign-out
affordances when it is `none`. The token panel (🔑) also hides — tokens are
meaningless when nothing verifies them.

## Loopback guardrail

`AUTH_MODE=none` means anything that can reach the port can read and rewrite every
document. Two checks, active **only** in that mode:

1. **Bind check.** Listen on `127.0.0.1` only. If `HOST` is set to anything else
   (`0.0.0.0`, a LAN address), refuse to start with an explanatory error rather
   than silently exposing the data.
2. **Origin / Host check** (Express middleware, before the `/api` guard, also
   applied at the WebSocket handshake):
   - If an `Origin` header is present, it must equal the server's own origin.
     Any web page the user visits can `fetch("http://localhost:3000/api/...")`;
     with no cookie to protect there is otherwise nothing stopping it. Non-browser
     clients (Claude Code, curl, the SDK) send no `Origin` and pass.
   - `Host` must be `localhost` or `127.0.0.1` (with optional port). This blocks
     DNS rebinding, where an attacker-controlled domain resolves to 127.0.0.1 and
     therefore sends its own `Host`.

   Rejections return 403 and are logged once with the offending value.

## Config

`.env.example` gains:

```
# "github" (default) or "none". "none" disables sign-in entirely and treats every
# caller as a single local admin — only safe bound to 127.0.0.1, which the server
# enforces. Intended for running live-md locally alongside VS Code / Claude Code.
AUTH_MODE=github
```

The GitHub variables become optional when `AUTH_MODE=none`.

## Tests

- `tests/unit/auth-mode.test.ts` — mode parsing, defaulting to `github` on unset
  and on unrecognised values; local principal is a singleton; `X-Agent-Id` creates
  an agent principal once and reuses it.
- Guardrail unit tests — foreign `Origin` rejected, absent `Origin` allowed,
  rebound `Host` rejected, both inert under `AUTH_MODE=github`.
- Startup refusal when `AUTH_MODE=none` and `HOST` is non-loopback.
- One e2e run with `AUTH_MODE=none` asserting a document opens and edits with no
  sign-in step. The existing `AUTH_DEV_LOGIN` seam and the GitHub-mode e2e suite
  stay as they are.

## Out of scope

Multi-user local mode, LAN sharing without auth, per-agent permissions in `none`
mode. If any of those are wanted later, the answer is `AUTH_MODE=github`.

## Estimate

Half a day, including tests.
