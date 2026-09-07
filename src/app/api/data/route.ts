import { NextRequest, NextResponse } from "next/server";
import { fetchRoster } from "@/lib/sheets";
import { fetchInvoicesFromSupabase as fetchInvoices } from "@/lib/supabase-invoices";
import { AUTH_COOKIE_NAME, decodeSession, findUser, getUsers } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // proxy.ts already gates every non-public route on a valid session, but
  // it only checks that SOME user is logged in — it doesn't know what
  // that user is allowed to see. Scoping (which centers' data actually
  // go out over the wire) is enforced here, server-side, so a center-
  // restricted account's browser never receives other centers' rows at
  // all — not just a client-side filter someone could bypass.
  const users = getUsers();
  if (!users) {
    return NextResponse.json({ error: "Server is misconfigured (no users set)" }, { status: 500 });
  }
  const cookie = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  const session = cookie ? decodeSession(cookie) : null;
  const user = session ? findUser(users, session.email) : undefined;
  if (!user || !session || user.passwordHash !== session.passwordHash) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    let invoices = await fetchInvoices();

    // Roster failure shouldn't take down the whole dashboard — the invoice
    // table is the primary content. Fall back to an empty roster and note
    // the error instead.
    let roster: Record<string, string[]> = {};
    let rosterError: string | null = null;
    try {
      roster = await fetchRoster();
    } catch (e) {
      rosterError = e instanceof Error ? e.message : "Unknown error";
    }

    if (user.scope !== "all") {
      invoices = invoices.filter((r) => r.centerName === user.scope);
      roster = { [user.scope]: roster[user.scope] || [] };
    }

    return NextResponse.json({
      invoices,
      roster,
      rosterError,
      fetchedAt: new Date().toISOString(),
      email: user.email,
      scope: user.scope,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
