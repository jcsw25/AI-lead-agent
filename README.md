# AI Revenue Department

An AI system that works like a sales and business-development employee: it decides who a
business should sell to, finds those companies, researches them, works out why they would
buy *now*, writes the outreach, reads the replies, and tracks everything through to
revenue — then learns from the result.

Singapore first (F&B, retail, hospitality). Geo-neutral by construction — no market,
season, or statute is hardcoded.

**Status: architecture and data model complete. No application code yet.**

---

## Documents

| | |
|---|---|
| [01 — Architecture](docs/01-architecture.md) | Stack, tenancy, agent runtime, model tiering, research, send gate, jobs, autonomy |
| [02 — Data model](docs/02-data-model.md) | Entity design and the five non-obvious decisions |
| [03 — Agent contracts](docs/03-agents.md) | All 13 agents as typed input/output schemas |
| [04 — Compliance](docs/04-compliance.md) | PDPA, DNC, Spam Control Act — and the design they force |
| [05 — Build order](docs/05-roadmap.md) | Phases 0–5 as tickets with acceptance criteria |
| [06 — Decisions](docs/06-decisions.md) | Nine ADRs: what was chosen, what was rejected, when to revisit |
| [`prisma/schema.prisma`](prisma/schema.prisma) | The schema — validated, 41 models and enums |

---

## The four decisions that define this system

1. **`Company` is global, `Prospect` is tenant-scoped.** Research a company once, use it
   for every customer. Strategy and relationships stay private. ([ADR-001](docs/06-decisions.md))

2. **The LLM never assigns the lead score.** It extracts features with evidence; a
   deterministic weighted sum produces the 0–100. Reproducible, explainable, and — unlike
   a model's opinion — refittable from actual conversion data. ([ADR-002](docs/06-decisions.md))

3. **Facts carry provenance or they don't count.** Research agents write `Claim` rows with
   source URL and quote. Unsourced facts cannot raise a score and cannot enter an email.
   Cold outreach publishes the model's mistakes in the customer's name — that risk gets
   an architectural answer, not a prompt. ([ADR-003](docs/06-decisions.md))

4. **One send gate, no bypass.** Suppression, provenance, consent, channel rules,
   statutory bulk thresholds, rate limits, approval — all in one function, committed in
   one transaction. ([ADR-006](docs/06-decisions.md))

## The compliance finding that shaped the product

Singapore's Spam Control Act 2007 deems messages "sent in bulk" above **100 same-subject
messages in 24h**, 1,000 in 30 days, or 10,000 a year. Cross that and every message
legally requires an `<ADV>` subject-line prefix plus a full unsubscribe facility — which
destroys open rates.

Staying under it means individually-researched, genuinely personalised outreach. That is
the same place the spec's own principle lands: *accuracy over quantity, relevance over
volume*. The system enforces the threshold in the send path and makes bulk EDM mode an
explicit, informed choice. Details and sources: [04 — Compliance](docs/04-compliance.md).

---

## Running it locally

Everything runs on your machine — **including the database**. No cloud account, no Docker,
no Postgres install. `npm run db:dev` starts PGlite (Postgres compiled to WASM) and serves
it over the real Postgres wire protocol, so Prisma treats it like any other server.

Two terminals:

```bash
npm run db:dev
```

```bash
npm run dev
```

Then open **http://localhost:3000**. First time only, seed the demo business:

```bash
npm run db:seed
```

Data lives in `./.pgdata` and survives restarts. `npm run db:reset` wipes and re-seeds.

### Working without an API key

With no `ANTHROPIC_API_KEY` in `.env`, agents return **clearly-labelled sample output** so
the whole product is explorable offline. Every screen that shows simulated data says so.
Add a key to `.env` and re-run any agent for real results — nothing else changes.

### Local dev gotchas (all already handled in `.env`)

| | Why |
|---|---|
| `sslmode=disable` | PGlite's socket server doesn't do SSL negotiation; without this Prisma's connection is dropped and you get a misleading "can't reach database". |
| `pgbouncer=true` | Disables Prisma's prepared-statement cache. Without it you hit `42P05: prepared statement "s0" already exists` on the second query. |
| `connection_limit=1` | PGlite serves one connection at a time. |
| `db push`, not `migrate dev` | `migrate dev` needs a shadow database that PGlite can't create. Local dev syncs the schema directly; versioned migrations start when you move to hosted Postgres. |

### Moving to hosted Postgres

When you want migration history or to deploy, create a project at
[neon.tech](https://neon.tech) or [supabase.com](https://supabase.com), point
`DATABASE_URL` (pooled) and `DIRECT_DATABASE_URL` (direct, port 5432) at it, and run
`npx prisma migrate dev --name init`. Nothing in the app code changes.

**Note:** a hosted database is not "going online" — the app still runs only on your
machine. Deployment is a separate, later step.

## The working chain

```
industry play → companies → key people → product match → cold email → reply → introduction
                                              ↓
                                     commission tracked
```

**Brokerage is the core model.** Your own catalogue is a `Supplier` with `isSelf = true`;
partners are suppliers with commission terms. The matchmaker treats them identically, so
"sell my own product" and "introduce two businesses and take a cut" are the same machinery
with different economics. A brokered email says so plainly — it names the supplier and
offers the introduction, because hiding it would be both worse copy and worse ethics.

### Products and services broker differently

A product has a price you can quote cold. A service has a price only *after* you
understand the problem — so `SupplierProduct.kind` splits the two and changes three things:

| | Product | Service |
|---|---|---|
| Matched on | industry fit | **observable pain** — hiring ads for repetitive roles, legacy stack in job postings, disconnected systems |
| First ask | buy it | **a diagnostic call**, priced at nothing or at a bounded audit |
| Price in the cold email | quoted | **suppressed** — nothing is scoped yet, so any number is wrong or anchors against you |
| Deal value | unit × quantity | engagement (day rate × days, or project fee) |

Services then get a second chain the products don't need:

```
discovery call → problems captured → scoped proposal (phases, risks, commission)
```

The binding rule: **the solution designer may only build phases around problems recorded
on the call.** Solutions invented for problems nobody raised are how services proposals
get ignored, so the constraint is in the prompt and the data model, not left to judgment.

## Verified working

Every step below was driven through the browser, not just compiled:

- **Discovery** — an accepted industry play produces 8 companies with named contacts
- **Matching** — each company matched to a product, spread across own and partner supply
- **Commission** — SGD 4,500 partner deal → SGD 540 at 12%, arithmetic not model output
- **Outreach** — draft written around the specific product, framed as an introduction
- **Approve & send** — moves the prospect to CONTACTED, writes the timeline entry
- **Reply → HOT** — reclassifies the lead, flips the match to INTERESTED, surfaces
  *Mark introduced*
- **Introduction** — match reaches INTRODUCED, Won/Lost controls appear
- `npx tsc --noEmit` passes clean

Three bugs found by testing: mock domains all collapsing to one registrable domain, the
matchmaker never picking a partner product (so commission never appeared), and two Zod
`.default()` type mismatches the dev server didn't catch.

## Not built yet

Real email sending through the compliance send gate, inbox sync and automatic reply
classification, company research and lead scoring. Until the inbox is connected, **Log a
reply** on a prospect writes a real inbound message and moves the pipeline exactly as a
live reply would. See [the roadmap](docs/05-roadmap.md).

## The pair database

The asset is a table of **A→B theses** plus real, sourced contact data on the A side.

```
Pairing (what A has ↔ what B needs, + trigger)
   └── SupplierLead (a real scraped company on side A)
          └── recruitment email → onboard → Supplier → Match → buyer outreach
```

`npm run db:seed:pairings` loads 12 starting theses. `/pairings` shows them and lets you
paste supplier websites to scrape; `/leads` is the resulting database with CSV export for
Google Sheets.

### The scraper

`npm run scrape -- domain1.com domain2.com`

Reads a company's **own published pages** — the defensible core, since that data is public
and published in a business capacity (PDPA business-contact exclusion). It:

- fetches and obeys `robots.txt`, one request per host at a time, ~1.2s apart
- identifies itself honestly via `SCRAPER_USER_AGENT`
- refuses LinkedIn, Facebook, Crunchbase, ZoomInfo and Apollo — scraping those breaks
  their terms regardless of how useful the data would be
- **never guesses an email pattern.** `firstname.lastname@domain` would inflate the hit
  rate and bounce; if it isn't on the page it isn't in the database
- records a source URL for every field, as a `Claim`

**Measured on 5 real Singapore HVAC companies:** 5/5 scraped, 5 phones, 3 emails,
**0 named decision-makers.** That last number is the important one — SME service
businesses in Singapore publish a phone and a generic inbox, not staff directories. Plan
outreach around role inboxes and phone/WhatsApp, not personalised email to a named person.

### Known limits

- JavaScript-rendered sites return nothing from raw HTML. Detected and flagged as
  `jsRendered` rather than silently reported as "no data".
- Address capture gets the unit and postal code reliably, the street line inconsistently.
- **Nothing validates which side of a pairing a scraped company belongs on.** Scrape HVAC
  companies against the automation pairing and they land on side A, where they belong on
  side B — and the recruitment email will read backwards. Check the pairing direction
  before scraping into it.
- Discovery seeds are manual (paste domains). Search-backed discovery needs
  `ANTHROPIC_API_KEY`.

## The spreadsheet

`npm run export:xlsx` → `pair-database.xlsx`, four tabs:

| Tab | |
|---|---|
| **Introductions** | The working surface. One row per potential or live introduction, both sides on the same line — teal columns are supplier A, amber are buyer B. |
| **Companies** | Master contact list, every route found, with the page each came from. |
| **Pairings** | The 12 A→B theses. |
| **Read me** | Legend, what blanks mean, and which cells are yours to edit. |

A **Data** column marks every row `REAL` (scraped from the live web) or `SAMPLE` (simulated
demo rows on reserved `.test` domains). Real rows sort first.

### Live Google Sheet

The Generator page has a **database** panel that connects a real Google Sheet and keeps it
current — every search syncs automatically.

It uses a **service account**, not user OAuth: no consent screen, no redirect flow, no
7-day token expiry, and it works from a background job. Setup is two env vars:

1. console.cloud.google.com → new project → enable **Google Sheets API**
2. Credentials → Create credentials → **Service account** → Keys → Add key → JSON
3. Put `client_email` in `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `private_key` in
   `GOOGLE_PRIVATE_KEY` (double-quoted, keeping the literal `
` sequences)
4. Restart, then either let the app create a Sheet or share one you own with the service
   account address as **Editor** and paste its URL

Sync is clear-then-write, so the Sheet mirrors the database exactly and re-running is
idempotent. Anything typed into it by hand is overwritten — notes belong in the app.

`/api/export/xlsx` remains as the no-credentials fallback.

**Keep suppression in the app, not the sheet.** The send gate reads opt-outs from Postgres;
a row deleted only in a spreadsheet will still be emailed.

### Not working

- **UEN and legal-name extraction.** Code is in `src/scraper/extract.ts` but returns
  nothing on real pages — the backwards-walk from "Pte Ltd" fails against live markup.
  Company names currently come from the page `<title>`, so they read as SEO headlines
  ("Best Aircon Servicing Singapore") rather than registered names.
- Address capture gets unit and postal code reliably, the street line inconsistently.

## Finding its own targets

`/pairings` → **Find suppliers (A)** / **Find buyers (B)** on any pairing. No pasting.

Two discovery sources behind one `SearchAdapter` interface:

| | Needs a key | Gives you |
|---|---|---|
| **OpenStreetMap (Overpass)** | No | Names, addresses, coordinates. A public API built for this — no terms problem. |
| **Anthropic web search** | Yes | Actual company websites, which is what the crawler needs. |

Overpass runs first because it's free. Anything with a website gets crawled; anything
without is still recorded from the directory data. A name, an address and a phone is a
real lead — discarding them would throw away most of the market.

### Measured OSM coverage, Singapore

| Industry | Found | Has website | Has phone |
|---|---|---|---|
| Clinics / healthcare | 200 | 13% | **50%** |
| Renovation contractors | 154 | 14% | 11% |
| Florists | 154 | 14% | 11% |
| Laundries | 123 | 6% | 8% |
| Aircon servicing | 22 | 9% | 9% |
| Pest control | 3 | — | — |

**The headline: OSM finds companies, not websites.** 6–14% carry a site, so the crawler
only fires on a minority. Phone coverage is the more useful number, and it varies wildly
by sector — clinics are half-covered, laundries barely.

Practical consequence: without an API key, OSM-driven discovery produces **phone-first
lead lists**. That suits the SME segment anyway, which publishes a number and not a staff
directory. With a key, web search resolves names to sites and the crawler does the rest.

Overpass is volunteer-run and shared. The adapter backs off on 429/504 with exponential
retry and identifies itself; don't remove that.
