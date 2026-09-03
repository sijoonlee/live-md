// Sign-in allowlist. Only GitHub logins/emails listed in ALLOWED_GITHUB may sign
// in; everyone else is authenticated by GitHub but rejected. Fails closed: an empty
// or unset allowlist admits no one, so a misconfiguration cannot silently open the
// door to any GitHub user.

export const parseAllowlist = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

export const isAllowed = (allowlist: string[], login: string | undefined, email: string | undefined): boolean => {
  if (allowlist.length === 0) return false;
  if (login !== undefined && allowlist.includes(login.toLowerCase())) return true;
  if (email !== undefined && email !== null && allowlist.includes(email.toLowerCase())) return true;
  return false;
};
