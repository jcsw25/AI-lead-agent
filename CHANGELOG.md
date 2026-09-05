# Changelog

## 2026-09-05 — everything since the initial commit

The first commit (`7b8f27f`, 2026-09-01) was a working discovery-and-drafting
pipeline. The four days since went into the two things it could not do: read
what came back, and decide who was worth writing to in the first place.

94 tracked files changed, 37 new source files (~7,100 lines), 2 new database
models.

---

### Reply understanding

Replies were stored and never read. Every one had to be opened by hand, and a
need probed weeks earlier stayed `PROBED` forever.

- **`src/agents/need-extractor.ts`** — reads a reply and extracts the need, the
  incumbent supplier, timing, and whether the sender is even the right person.
- **`src/lib/demand/extract.ts`** — the gate. Every extracted claim carries the
  quote it came from, and if that quote is not in the reply *verbatim*, the
  whole extraction is discarded and the need stays `PROBED`. A confident
  fabrication is worse than no answer, because it gets acted on.
- **`src/lib/demand/category.ts`** — matches the reply's need against the
  category we probed. Uses F1 over the two term sets, not one-sided containment.

Two bugs found by testing rather than by reading the code:

- A reply saying *"Aircon we handle in house. But if you know anyone who does
  pest control"* confirmed the **aircon** need. The field was called `hasNeed`,
  and the model answered the question the name asked. Renamed
  `hasNeedInThisCategory`, and the constraint stated in the prompt.
- One-sided scoring gave *"commercial cleaner"* a perfect 1.00 against four
  different cleaning trades at once.

### Leaks — who is losing the traffic they already have

New targeting layer. The premise: a company nobody can find has no leads to
lose, and a company with a perfect site has nothing to fix. Only the overlap is
worth a cold pitch.

- **`src/scraper/render-mode.ts`** — classifies each page `static` / `hydrated` /
  `spa` and sets a `reliable` flag. This is the load-bearing part. On a
  client-rendered page the enquiry form is built by JavaScript and simply is not
  in the HTML we read, so "no enquiry form" is a blind spot, not a finding.
  **34% of reachable sites turn out to be client-rendered** and can never be
  assessed. They now score zero leaks rather than a clean bill of health.
- **`src/scraper/leaks.ts`** — detects the leaks themselves: no above-fold call
  to action, enquiry form buried down the page, a wall of prices with no way to
  tell which applies. `emailWorthyLeak()` picks the one line worth opening an
  email with, ordered by **how specific it is, not how severe** — severity
  ordering made every card on the page say the same sentence.
- **`src/lib/scoring/pitch-priority.ts`** — `priority = (reach / 100) x leak`.
  Multiplied, not added, so either half being zero ends it.
- **SERP position capture** — Serper was already returning `position` on every
  organic result and we were throwing it away. Now stored as `serpBestPosition`
  and `serpAppearances`. A free traffic proxy; no Similarweb bill.

Backfilled across the whole database, not just aircon: **991 pages read, 575
leaking, 580 companies with a search position.** Pitchable targets went from 8
to 200.

### Business acquisition pipeline

A second, parallel pipeline for buying businesses rather than selling to them.

- **`src/lib/acquisition/marketplaces.ts`**, **`index-crawl.ts`**,
  **`listings.ts`**, **`targets.ts`** — scrapes Singapore business-for-sale
  listings, plus off-market targets found by industry that were never listed.
- **`src/agents/listing-extractor.ts`** — pulls asking price, revenue, profit and
  the profit *term* out of listing prose.
- **`src/agents/acquisition-enquiry.ts`** + **`quality-acquisition.ts`** — a
  separate writer and its own tone gate. Asks about NDA, EBITDA and financials.
- **`src/app/acquisitions/`** — the UI.

Caught in a dry run: multiples were being computed across incompatible profit
terms, and **40 of 41 were wrong** — one preschool showed 26x on a *monthly*
profit figure. A multiple is now only computed when the term is actually EBITDA.
Of 91 listings scraped, exactly **one publishes EBITDA**; 20 quote monthly profit
and 13 quote SDE.

### Email tone

Three rounds of rewrites. The drafts read like a mail-merge: no greeting, an
opening that narrated the sender browsing the recipient's website, two or three
apologies for having written, and a sign-off five other drafts also used.

**`src/agents/outreach.ts`** now enforces four fixed steps:

1. Open on what you tried to do on their site and couldn't. First sentence, no preamble.
2. Who you are, in one line — a developer who builds this for trades firms.
3. The fix, named: **smart scheduling** and **automated reminders**, never "a booking system".
4. Offer a call, once, and stop.

**`src/lib/outreach/quality.ts`** — mechanical checks, because a prompt is a
request and the gate is what holds. Twelve pattern families now, including the
two added last: **apologetic close** ("no reply needed", "I'll leave you to it")
and **invented urgency** ("before the busy season").

One earlier rule of mine caused the problem it was meant to prevent: *"do not
open on what they lack"* was written to keep the email out of the
predatory-audit register, and it pushed the actual point out of the opening,
leaving a manufactured season and an apology in its place. Replaced with *"tell
it as your own experience as a visitor"*, which keeps it civil without going
vague.

`scripts/test-tone.ts` — 10 cases, every bad one lifted from a draft that was
really sitting in the queue. **36 of the 62 existing drafts fail the tightened
rules** and need regenerating.

### Calls

- **`src/app/calls/`** + **`src/lib/calls/queue.ts`** — a call station: one
  company at a time, the number, what to open with, and outcome buttons.
- **`src/lib/calls/sheet.ts`** + `npm run calls:sync` — **two-way** sync with a
  new Google Sheet tab. Edits made in the sheet come back; the sheet is not a
  read-only mirror.

Deliberate: undoing a call outcome does **not** reverse a suppression. If someone
said don't call again, an accidental undo must not put them back in the queue.

### Data quality

- **`src/lib/facts.ts`** — fixed a defect where the outreach writer read
  `company.signals` (the `BuyingSignal` table, **0 rows, for every email ever
  drafted**) while the real description arrived under a heading the rules forbade
  it to use. Verified facts available to the writer: **0 to 966**.
- **`src/lib/ingest-guards.ts`** — rejects non-companies, foreign entries and
  malformed numbers at ingest, plus `cleanLegalName()` for extractor artefacts
  like *"GreenCool GreenCool Air-Condition Pte Ltd"*.
- **`npm run clean`** — backfill for what was already stored: **66 non-companies
  removed, 75 renamed, 135 bad phone numbers cleared.**

The rename rule was caught by a dry run before it ran for real — it wanted to
turn *"Hershey's Chocolate World"* into *"Rwsentosa"*. Narrowed to fire only when
nothing distinctive would remain.

### Lead magnet

- **`src/lib/leadmagnet/report.ts`** + **`src/app/r/[token]/route.ts`** — a
  tokenised per-company site report to link from an email, instead of asking a
  stranger for a call with nothing in hand.

### UI

- **Pairings** (was Matchmake) and **Quick Email** (was Approvals) — rebuilt.
  Quick Email is now a scannable list with one draft open beside it; the old page
  rendered all 64 as expanded editors. It also **shows the tone violations it was
  already computing and silently discarding**, so a flagged draft no longer looks
  identical to a clean one.
- **Leaks** — reworked twice, ending as a work queue: one company per card, the
  pitch score as the headline, and the exact opening line quoted as it would be
  said. Quick actions push a lead to the top of the email or call queue.
- Sidebar navigation for the new sections.

### Reliability

- **Generator deadlines** — the generator could hang indefinitely; no adapter had
  a deadline and Anthropic's was 300s with Overpass retrying at 90s each.
  Per-adapter and 150s overall deadlines added.
- **Follow-ups are now stored.** The writer had been producing two per email and
  returning them to nothing. Most cold-email replies come from the second and
  third touch, so that was the majority of the value being generated and thrown
  away. `Message.parentMessageId` added.
- **Call-queue ordering** fixed — a pinned company outside the `limit x 6` fetch
  window never reached the sort, so the pin appeared to do nothing.

### Schema

New models `AcquisitionTarget` and `SiteReport`. New fields: `serpBestPosition`,
`serpAppearances`, `pinnedForCallAt`, `pinnedForEmailAt`, `renderMode`,
`reliable`, `leakScore`, `leakFindings`, `missingH1`, `noAboveFoldCta`,
`formDepthPct`, `parentMessageId`, `outcome`.

Three tables are now marked **UNUSED** in the schema with the reason written down
rather than left to be rediscovered — `BuyingSignal` in particular, because
funding rounds and hiring sprees are enterprise phenomena a twelve-person
Singapore aircon firm does not publish.

### Repo hygiene

- **63 one-off diagnostic scripts moved to `scripts/archive/`** — none was in
  `package.json`, several duplicated each other with different hard-coded limits.
  Moved rather than deleted, because some had never been committed and deleting
  them would have been unrecoverable. Excluded from `tsconfig`.
- 13 new npm scripts wired up: `extract`, `listings`, `leaks`, `serp`, `clean`,
  `calls:sync`, `fill:pairings`, and the test suites.
- `tsconfig.tsbuildinfo` gitignored.

---

## Known limitations

Honest state of things, so nobody reads the above as further along than it is.

- **Zero emails have been sent to a real company.** The whole pipeline is
  validated against fixtures and stored data, not against anyone replying.
- **36 of 62 drafts fail the current tone rules** and need regenerating. Blocked
  on Anthropic API credit.
- **`PUBLIC_BASE_URL` is still `localhost:3000`**, so lead-magnet report links
  are omitted from drafts. The send gate blocks any body containing a localhost
  link, which is why this fails safe rather than silently.
- **34% of sites cannot be assessed for leaks** — client-rendered, and an absence
  there cannot be proven.
- **About half of any given trade does not rank in 100 results** for its own
  search terms, so reach is unknown for them.
- Total model spend to date: **~$7.94**.

## Standing principles

- **ADR-002** — the model never assigns a score. It extracts features; arithmetic
  produces the number.
- **ADR-003** — a fact carries its provenance or it does not count.
- An **absence** is only ever asserted where the page was fully delivered.
- **Mechanical gates over prompt instructions.** A prompt is a request. The gate
  is what holds.
