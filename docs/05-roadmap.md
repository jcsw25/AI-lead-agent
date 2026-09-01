# Build order

Spec §23's five phases, expanded into tickets with acceptance criteria. The ordering rule:
**every phase ends with something demonstrable**, and the §24 chocolate scenario gets
progressively more real rather than being faked early and rebuilt later.

Estimates assume one developer working with Claude Code. They are relative sizes, not
commitments.

---

## Phase 0 — Foundations (~3 days)

Not in the spec's list, but Phases 1–3 all depend on it.

| # | Ticket | Done when |
|---|---|---|
| 0.1 | Next.js 15 + TS + Tailwind scaffold, Neon project, `prisma migrate` green | `npm run dev` serves; migration applied to hosted Postgres |
| 0.2 | Seed: `Region(SG)`, 3 years of `SeasonalWindow`, `ComplianceRule`, default `ScoringModel` | `npm run db:seed` idempotent |
| 0.3 | `runAgent()` runtime — parse + Zod, `AgentRun` row, usage/cost capture, refusal branch, retries | A trivial agent runs; its cost and tokens appear in `agent_runs` |
| 0.4 | pg-boss wiring on `DIRECT_DATABASE_URL`, one worker process, `/api/health` | A test job enqueues and completes; retry on throw verified |
| 0.5 | Auth (Auth.js), `Business` + `BusinessMember`, tenant-guard Prisma extension | A query on a tenant-scoped model without `businessId` **throws** |
| 0.6 | `mock` EmailAdapter (send → DB, canned inbound replies) | Full send/receive round-trip with no network |

**0.3 and 0.6 are the two that pay for themselves repeatedly.** Do not skip the mock
adapter to "just wire Gmail" — Phases 1–3 become untestable.

---

## Phase 1 — Discovery (~2 weeks)

Onboarding → analysis → ICPs → prospects → research → scoring.

| # | Ticket | Done when |
|---|---|---|
| 1.1 | Onboarding form: business, offerings, region, materials, optional CSV of customers | Data persists; CSV import maps to `Company`/`Contact` with `sourceType = user_upload` |
| 1.2 | **Business Analyst agent** | Chocolate input produces a profile with ≥3 B2B opportunities and ≥1 open question |
| 1.3 | Profile review UI — user can correct any AI-generated block | Edits persist and bump `version` |
| 1.4 | **ICP Agent** + `compositeRank` computed in code | ≥5 ranked ICPs, each with a machine-executable `filter` |
| 1.5 | **Prospect Hunter** with `web_search`, capped at 50/run | ≥20 real SG companies; **100% carry a source URL**; zero duplicates by domain |
| 1.6 | Dedupe engine: eTLD+1 normalisation, name fuzzy-match | "ABC Holdings Pte Ltd" and abcholdings.com.sg resolve to one `Company` |
| 1.7 | **Company Research Agent** → `Claim` rows + promoter | Company page shows every fact with its source and date |
| 1.8 | **Deterministic scorer** + `ScoreSnapshot` | Score reproducible on re-run; UI renders the factor breakdown |
| 1.9 | Prospect list + company detail UI | Sort by score, filter by tier/stage/ICP |
| 1.10 | **"Find Customers"** button wiring the whole chain | One click → ranked, sourced, scored prospects |

**Phase 1 exit demo:** *"I own a premium chocolate company in Singapore"* → ranked ICPs →
a real list of Singapore companies → each with research, sources, and an explained score.
Steps 1–7 of the §24 scenario.

---

## Phase 2 — Outreach (~2 weeks)

| # | Ticket | Done when |
|---|---|---|
| 2.1 | Decision-maker identification + `ProspectContact` roles | Contacts have title, department, source; unsourced ones are excluded |
| 2.2 | **Value Prop Agent** + post-hoc claim validation | Every factual statement maps to a verified claim; unbacked ones are regenerated away |
| 2.3 | **Campaign Agent** — objective, subjects, sequence, timing | Full sequence generated and editable |
| 2.4 | Campaign editor UI | Every field editable before approval |
| 2.5 | **Send gate** — all 8 steps, transactional | Test suite: suppressed contact blocked; unsourced contact blocked; 101st same-subject message in 24h blocked or `<ADV>`-tagged |
| 2.6 | Approval queue UI | Approve / edit-and-approve / reject; edits recorded |
| 2.7 | Message materialisation + scheduled sending via `mock` | Sequence advances on schedule; stop-on-reply works |
| 2.8 | Gmail/Graph adapter + OAuth, encrypted token storage | Real send from the user's mailbox, threaded |
| 2.9 | Unsubscribe endpoint + suppression | One click, no login, `SuppressionEntry` written before the confirmation renders |

**Phase 2 exit demo:** steps 8–12 — contact identified, personalised value prop and email
generated, approved by a human, sent from the user's own mailbox.

---

## Phase 3 — Conversation (~1.5 weeks)

| # | Ticket | Done when |
|---|---|---|
| 3.1 | Inbox sync job, incremental cursor, thread matching | Replies attach to the right `Thread` and `Prospect` |
| 3.2 | **Conversation Agent** classification | All 10 `ReplyClass` values exercised by fixtures |
| 3.3 | Hard rules in code: unsubscribe, negative, OOO, wrong-contact | Verified by test, not by prompt |
| 3.4 | Reply drafting + approval | Draft appears in the queue with the thread in context |
| 3.5 | CRM timeline | Renders the §11 example: discovered → replied → classified → approved → sent |
| 3.6 | Stage automation + `nextActionAt` | Stages advance from events; follow-ups appear when due |
| 3.7 | Meetings + deals | Meeting logged, deal created, revenue recorded |

**Phase 3 exit:** the complete §24 scenario, all 17 steps, end to end. **This is the
milestone that proves the product.**

---

## Phase 4 — Proactivity (~1.5 weeks)

The phase that turns a tool into a department.

| # | Ticket | Done when |
|---|---|---|
| 4.1 | **Opportunity Agent** — company + market modes, signal expiry | Signals carry sources and expiry; stale ones decay out of scoring |
| 4.2 | Seasonal engine driven by `SeasonalWindow` + `buyingLeadDays` | Christmas gifting surfaces ~45 days out **with no user action** |
| 4.3 | Nightly discovery + re-scoring (Batch API) | Overnight run; cost per prospect logged |
| 4.4 | **Strategy Agent** → `Recommendation` with `actionPayload` | Every recommendation has a working one-click action |
| 4.5 | **AI Opportunity Centre** dashboard (§12) | Hot leads, new prospects, follow-ups due, new signals, ranked recommendations |
| 4.6 | Campaign analytics | Open/reply/positive rates by campaign, step, subject variant |
| 4.7 | Per-business cost meter + monthly cap | Spend visible; cap halts autonomous work and alerts |

---

## Phase 5 — Learning (~1 week, then continuous)

| # | Ticket | Done when |
|---|---|---|
| 5.1 | `OutcomeStat` nightly rollup | Conversion by industry, size, title, signal type, angle |
| 5.2 | Revenue attribution back to campaign / signal / ICP | Deal traces to the signal that triggered outreach |
| 5.3 | **Performance Agent** with significance gating | Findings under the sample threshold are stored, not surfaced |
| 5.4 | Weight refitting → new `ScoringModel` version, explicit acceptance | Proposed weights shown with expected impact; nothing auto-applies |
| 5.5 | ICP feedback loop | Underperforming ICPs demoted, adjacent segments proposed |

**Phase 5 exit:** the system can say *"technology companies with 100–500 employees are
your highest-converting segment"* — **and show the sample size behind it.**

---

## Sequencing risks

| Risk | Mitigation |
|---|---|
| Prospect Hunter returns plausible fake companies | Source requirement enforced in the post-processor, not the prompt (1.5). Manually verify the first 50 by hand. |
| SG contact-email coverage is thin from public sources | Expect it. Fall back to department/role targeting and web forms; consider ACRA/BizFile data before buying a contact database. |
| Gmail OAuth verification takes weeks | Start the Google verification application during Phase 1. Test-user mode covers development. |
| Deliverability collapses on a new domain | Warm-up ramp + per-mailbox caps from the first real send (2.8), not after the first blacklisting. |
| Scope creep across 13 agents | Phases 1–3 need 8 of them. Agents 11–13 are Phase 4–5. Resist building all thirteen before one works. |
| Autonomous loop runs up API spend | 4.7 exists for this. Consider moving it into Phase 0 if nightly jobs land earlier than planned. |
