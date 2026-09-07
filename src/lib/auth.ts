export const AUTH_COOKIE_NAME = "dashboard_auth";

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// scope: "all" for admin (sees every center), or an exact Center Name
// string (must match the "Payment terms" sheet's Center Name column
// exactly) for a user restricted to just that one center.
export interface DashboardUser {
  email: string;
  scope: "all" | string;
  passwordHash: string;
}

// Parsed from the DASHBOARD_USERS env var (a JSON array) — the single
// source of truth for who can log in and what each person can see.
// Never hardcoded here: this repo is public, so no real credential or
// hash may live in source.
export function getUsers(): DashboardUser[] | null {
  const raw = process.env.DASHBOARD_USERS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function findUser(users: DashboardUser[], email: string): DashboardUser | undefined {
  const normalized = email.trim().toLowerCase();
  return users.find((u) => u.email.toLowerCase() === normalized);
}

// Cookie value is "<email>|<sha256(password)>". The hash is re-verified
// against the SERVER's own stored hash for that email on every request
// (in proxy.ts and any scoped API route) — never trusted on its own —
// so tampering with the email in a cookie doesn't let someone claim a
// different account without actually knowing that account's password.
export function encodeSession(email: string, passwordHash: string): string {
  return `${email.toLowerCase()}|${passwordHash}`;
}

export function decodeSession(cookieValue: string): { email: string; passwordHash: string } | null {
  const idx = cookieValue.indexOf("|");
  if (idx === -1) return null;
  return { email: cookieValue.slice(0, idx), passwordHash: cookieValue.slice(idx + 1) };
}
