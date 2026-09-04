// Who made an edit. There is no authentication here and nothing to verify — this
// build runs on loopback for one person — so an author is just a label, kept
// because "who wrote this paragraph, me or the agent?" is worth answering even when
// "may they?" is not a question anyone is asking.
//
// Humans are the local user; an agent names itself with `X-Agent-Id`.

export const LOCAL_AUTHOR = "local";

const AGENT_HEADER = "x-agent-id";
const MAX_LABEL = 100;

// Trim to something sane: this string is stored on every activity row and shown in
// the UI, and nothing upstream constrains it.
const clean = (value: unknown): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_LABEL ? trimmed : undefined;
};

export const authorFrom = (headers: Record<string, unknown>): string =>
  clean(headers[AGENT_HEADER]) ?? LOCAL_AUTHOR;
