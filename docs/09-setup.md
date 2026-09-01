# Setup: live discovery into a live Google Sheet

Everything needed to get from a clean checkout to real companies flowing into a Sheet.

**Two paid/registered things are required.** Everything else is already in the repo.

| | What | Cost | Time |
|---|---|---|---|
| 1 | Anthropic API key | pay-per-use, ~$3–6 per 100 companies | 2 min |
| 2 | Google service account | free | 5 min |

---

## Step 0 — Prerequisites

Already present on this machine, listed for a fresh one:

- **Node 20+** (`node -v`) — the app and scraper
- **Python 3.10+** with `openpyxl` (`pip install openpyxl`) — only for the `.xlsx` export;
  not needed if you use the live Sheet
- No Docker, no Postgres install, no cloud database

---

## Step 1 — Install and start the database

```bash
cd C:\Users\User\revenue-agent
npm install
```

The database runs locally as PGlite (Postgres compiled to WASM). **Leave this terminal
open:**

```bash
npm run db:dev
```

In a second terminal, create the tables and load the seed data:

```bash
npm run setup
```

That runs schema push → demo business → 69 pairings. Data lives in `./.pgdata`.

---

## Step 2 — Anthropic API key

This is what turns discovery from "OpenStreetMap only" into real web search, and turns
classification from keyword matching into actual reading.

1. Go to **console.anthropic.com** → API Keys → Create Key
2. Add credit under Billing (start with $20; the system logs every cent it spends)
3. Add to `.env`:

```bash
ANTHROPIC_API_KEY="sk-ant-..."
```

**What changes the moment this is set:**

| | Without | With |
|---|---|---|
| Finding companies | OpenStreetMap only — names and phones, 6–14% have websites | Web search returns actual company websites, so the crawler fires on most results |
| Company classification | keyword overlap | reads the site and reasons about it |
| Pairing generation | unavailable | ~240 pairings from a full sector sweep |
| Email copy | template | written per company |

Cost control: `AGENT_MONTHLY_BUDGET_USD` in `.env`, and every run's cost is visible at
`/runs`.

---

## Step 3 — Google service account for the live Sheet

A service account is a robot Google account the app signs in as. Chosen over normal OAuth
deliberately: no consent screen, no browser redirect, no 7-day token expiry, works
unattended.

1. **console.cloud.google.com** → create a project (any name)
2. **APIs & Services → Library** → search "Google Sheets API" → **Enable**
3. **APIs & Services → Credentials** → Create credentials → **Service account**
   - Name it anything. Skip the optional role and access steps.
4. Click the service account you just made → **Keys** → Add key → Create new key → **JSON**
   → a file downloads
5. Open that JSON. You need exactly two fields from it:

```bash
# .env
GOOGLE_SERVICE_ACCOUNT_EMAIL="something@your-project.iam.gserviceaccount.com"
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
```

`GOOGLE_SERVICE_ACCOUNT_EMAIL` is the JSON's `client_email`.
`GOOGLE_PRIVATE_KEY` is its `private_key`, **double-quoted, keeping the literal `\n`
sequences exactly as they appear in the JSON**. Do not convert them to real line breaks —
this is the single most common setup failure, and the app reports it specifically if you
get it wrong.

6. Restart the app.

### Connecting the Sheet

Go to `/generator`. The **database** panel now offers two routes:

- **Create a new Sheet for me** — the app creates it, owned by the service account, and
  syncs everything in. Fastest.
- **Use a Sheet you already own** — share it with the service account address as
  **Editor** first, then paste the URL. Do this if you want to own the file.

Once connected the panel shows **Open Google Sheet ↗** and the last sync time.

---

## Step 4 — Run it

```bash
npm run dev
```

Open **http://localhost:3000/generator**.

**Search by industry** — type a trade, get real companies with contact routes. Tick
*Also crawl their websites* for deeper extraction (slower).

**Search by company** — give a domain or name. It scrapes them, works out what they do,
and shows every way to link them, in both directions.

Both sync to the Sheet automatically when it is connected.

Command line equivalents:

```bash
npm run discover -- laundry 20     # find + scrape targets for a pairing
npm run scrape -- example.com.sg   # scrape specific domains
npm run export:xlsx                # regenerate the .xlsx
```

---

## The intended loop

```
/pairings   pick or generate an A→B thesis
    ↓
/generator  search the industry — finds and scrapes companies
    ↓
/leads      review contact quality, write recruitment emails
    ↓
/outreach   draft, review, send through the compliance gate
    ↓
/prospects  track replies: contacted → warm → hot → introduced
    ↓
Google Sheet  mirrors all of it, live
```

---

## What "search on Google" actually means here

Worth being exact, because it is not Google.

Discovery uses **Anthropic's server-side web search** (searches the live web, returns real
pages with sources) and **OpenStreetMap Overpass** (free, no key, good for local
businesses). Neither is the Google Search API.

If you specifically need Google results, that is **Google Custom Search JSON API** — 100
free queries/day then $5 per 1,000 — and it is **not built**. It would slot in as another
`SearchAdapter` alongside the two existing ones; roughly an hour of work. Say the word if
Google specifically matters rather than "searching the web".

---

## Optional: sending email

Not required for discovery. Needed only when you want outreach to actually leave the
machine — see [08-going-live.md](08-going-live.md).

```bash
EMAIL_ADAPTER="resend"          # or "gmail"
RESEND_API_KEY="re_..."
```

Also set the sender identity at `/settings` — an unsolicited commercial message must carry
a working contact route, and the gate blocks sends without one.

---

## Verifying it works

```bash
npm run check          # typecheck + schema validation, should exit 0
```

Then, in the app:

1. `/generator` → search "dental clinic" → companies appear, count rises
2. The **database** panel shows a recent sync time
3. Open the Sheet → three tabs populated
4. `/runs` → agent runs listed with cost

If the Sheet does not update, the panel shows the exact Google error.

---

## Known limits

- **Not tested against real Google credentials.** JWT signing, token exchange and the
  write path are unexercised — I have no service account. Straightforward REST, but expect
  a bump on first run.
- **UEN and legal-name extraction does not work.** Company names come from the page
  `<title>`, so they read as SEO headlines rather than registered names.
- **Street lines in addresses are inconsistent**; unit and postal code are reliable.
- **Nothing validates which side of a pairing a scraped company belongs on.** Check the
  direction before scraping into it, or recruitment emails read backwards.
- **Gmail OAuth flow is not wired to a button.** Resend is the working send route.
