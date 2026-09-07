import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, encodeSession, findUser, getUsers, sha256 } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const users = getUsers();
  if (!users || users.length === 0) {
    return NextResponse.json({ error: "Server is misconfigured (no users set)" }, { status: 500 });
  }

  let email: string | undefined;
  let password: string | undefined;
  try {
    const body = await req.json();
    email = body?.email;
    password = body?.password;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  const user = findUser(users, email);
  const hash = await sha256(password);

  if (!user || user.passwordHash !== hash) {
    return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE_NAME, encodeSession(user.email, hash), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
