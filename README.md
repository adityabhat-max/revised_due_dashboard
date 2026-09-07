# Due Invoices Dashboard

Live, searchable dashboard of outstanding due invoices for Isaac Wellness, reading
from the **"Payment terms"** tab of the shared Google Sheet. Built with Next.js,
deployed on Vercel.

Data is fetched fresh from Google Sheets on every page load (via `/api/data`) —
this is not a static snapshot. Access is per-account: each login has its own
email/password and its own **scope** — an admin account sees every center,
a center-restricted account only ever sees that one center's data (enforced
server-side, not just hidden in the UI).

## Local development

1. Copy `.env.example` to `.env.local` and fill in:
   - `GOOGLE_SHEET_ID` — the sheet's ID (from its URL, between `/d/` and `/edit`)
   - `SERVICE_ACCOUNT_JSON` — the full contents of the Google service-account key
     JSON file, as one line
   - `DASHBOARD_USERS` — a JSON array of accounts (see `.env.example` for the
     exact shape and how to generate a password hash)
2. Install dependencies and run:
   ```bash
   npm install
   npm run dev
   ```
3. Open [http://localhost:3000](http://localhost:3000) — it'll redirect to
   `/login` first.

## Deploying to Vercel

1. Push this repo to GitHub.
2. In Vercel, "Add New Project" → import this GitHub repo. It auto-detects
   Next.js, no config needed.
3. Before the first deploy (or in Project Settings → Environment Variables
   afterward), add the same variables as above: `GOOGLE_SHEET_ID`,
   `SERVICE_ACCOUNT_JSON`, `DASHBOARD_USERS`.
4. Deploy. If `DASHBOARD_USERS` is missing or invalid, every page will show a
   plain 500 error explaining that — fix it and redeploy.

## How access control works

`src/proxy.ts` (Next.js's server-side request interceptor) checks for a cookie
proving the visitor is a valid, logged-in account, redirecting to `/login` if
not. `/login` posts `{email, password}` to `/api/login`, which looks the email
up in `DASHBOARD_USERS`, hashes the submitted password, and compares it against
that account's stored `passwordHash` — plaintext passwords are never stored,
only sha256 hashes. On success it sets an `httpOnly` cookie encoding the email
and password hash together; every subsequent request re-verifies that hash
against the server's own config rather than trusting anything client-supplied,
so editing the cookie to claim a different account doesn't work without also
knowing that account's real password.

**Scoping** is enforced in `/api/data`, not just in the UI: it looks up the
logged-in account's `scope` and, if it isn't `"all"`, filters the invoices
(and the Sold-By roster) down to just that one center *before* the response
ever leaves the server — a restricted account's browser never receives other
centers' data over the network, so there's nothing to leak by inspecting
dev tools.

### Managing accounts

Add, remove, or change accounts by editing the `DASHBOARD_USERS` JSON in
Vercel's Environment Variables and redeploying. To generate a password hash
for a new or rotated password:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('the-password').digest('hex'))"
```

`scope` must be either `"all"` or an exact match of a value in the "Payment
terms" sheet's **Center Name** column (e.g. `"Greater Kailash, New Delhi"` —
copy it exactly, including punctuation).

## Data model

`src/lib/sheets.ts` reads the "Payment terms" tab directly via the Google
Sheets API (read-only scope) and returns every line-item row, typed. The
dashboard page (`src/app/page.tsx`) does all filtering/sorting/searching
client-side against whatever dataset `/api/data` returned for that account
(already scoped server-side, if applicable) — no further server-side query
params.

Each row is one line item on an invoice — one invoice can have multiple rows
(multiple purchased items). The 1st/2nd/3rd Payment Date/Amount columns are
populated when staff have written a payment plan into that invoice's Invoice
Notes in the source Zenoti report (see the separate `payment_notes_parser.py`
tool in the `DUE INVOICE` project) — most rows won't have one yet.
