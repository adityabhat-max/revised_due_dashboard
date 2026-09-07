import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, decodeSession, findUser, getUsers } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/login"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const users = getUsers();
  if (!users || users.length === 0) {
    return new NextResponse(
      "DASHBOARD_USERS is not set (or invalid). Add it in your Vercel project's Environment Variables, then redeploy.",
      { status: 500 }
    );
  }

  const cookie = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  const session = cookie ? decodeSession(cookie) : null;
  const user = session ? findUser(users, session.email) : undefined;

  if (user && session && user.passwordHash === session.passwordHash) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
