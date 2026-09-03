import {authDisabled} from "./auth-mode.js";

// Guardrail for `AUTH_MODE=none`. With authentication off, anything that can reach
// the port can read and rewrite every document, so the open mode is only safe bound
// to the loopback interface — and even there a browser needs holding back.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

// Where to listen. In open mode this must be loopback: refuse to start otherwise
// rather than silently exposing the documents to the network.
export const resolveBindHost = (configured: string | undefined, disabled = authDisabled): string => {
  const host = configured?.trim() || (disabled ? "127.0.0.1" : "0.0.0.0");
  if (disabled && !LOOPBACK_BINDS.has(host)) {
    throw new Error(
      `AUTH_MODE=none may only bind to loopback, but HOST is "${host}". ` +
        `Either bind to 127.0.0.1 or set AUTH_MODE=github to require sign-in.`,
    );
  }
  return host;
};

const hostname = (value: string): string => {
  // Strip the port, keeping a bracketed IPv6 literal intact.
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  const colon = value.lastIndexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
};

// A request is refused when it either looks like it came from another website, or
// was addressed to a name that merely resolves to us.
//
// - Origin: any page the user visits can `fetch("http://localhost:3000/api/…")`,
//   and with no cookie or token to protect there is otherwise nothing stopping it.
//   Non-browser clients (an agent, curl, the SDK) send no Origin and pass through.
// - Host: blocks DNS rebinding, where an attacker-controlled domain resolves to
//   127.0.0.1 and so carries its own Host header.
export const loopbackRejection = (
  headers: {origin?: string; host?: string},
  port: number,
): string | undefined => {
  const host = headers.host;
  if (!host || !LOOPBACK_HOSTNAMES.has(hostname(host))) {
    return `unexpected Host header "${host ?? "(absent)"}"`;
  }
  const origin = headers.origin;
  if (origin === undefined) return undefined; // not a browser
  let originHost: string;
  try {
    const parsed = new URL(origin);
    originHost = parsed.hostname;
    if (parsed.port && Number(parsed.port) !== port) return `cross-origin request from "${origin}"`;
  } catch {
    return `unparsable Origin header "${origin}"`;
  }
  return LOOPBACK_HOSTNAMES.has(originHost) ? undefined : `cross-origin request from "${origin}"`;
};

const warned = new Set<string>();

// Log each distinct rejection reason once, so a misconfigured client is visible
// without flooding the console.
export const noteRejection = (reason: string): void => {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.warn(`[loopback-guard] refused: ${reason}`);
};
