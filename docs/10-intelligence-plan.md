# From lead scraper to sales intelligence: architecture assessment

Written before any code changes, as asked. Inspection first, then A–G.

---

## What is actually there

I inspected all 49 schema models, 10 agents, the adapters and the UI. The important
distinction is **wired** versus **modelled but never implemented** — and there is more of
the latter than I have previously admitted.

| Subsystem | Status | Verdict |
|---|---|---|
| Serper discovery: query variants, paging, exclusions, dedupe | **Wired**, 86 companies / 38s | **Retain** |
| Web scraper: robots.txt, rate limiting, contact extraction | **Wired** | **Retain** |
| `Claim` — evidence with source URL, date, confidence, expiry | **Wired** (scraper writes it) | **Retain, extend** |
| `AgentRun` — per-call model, tokens, cost, latency | **Wired** | **Retain, extend** |
| `SearchAdapter` interface (Serper / Anthropic / Overpass) | **Wired** | **Retain** |
| Send gate: suppression, provenance, statutory limits, approval | **Wired**, tested | **Retain** |
| Domain normalisation + eTLD+1 dedupe | **Wired** | **Retain, extend** |
| `ScoringModel` + `ScoreSnapshot` — weights, factor breakdown | **Schema only. Never written or read.** | **Build** |
| `OutcomeStat` — learning rollups | **Schema only.** | **Build (Phase 5)** |
| `BuyingSignal` — type, strength, expiry, source | Schema + one write path | **Refactor** |
| Qualification / rejection | Only a `stage` enum. No engine, no reasons. | **Build** |
| `Pairing` — 69 A→B theses | Wired, but static and industry-level | **Refactor into the offer engine** |
| Company intelligence profile | Fields scattered across Company/Claim/Signal | **Refactor into a view** |
| Research tiers and budgets | Does not exist | **Build** |
| Decision-maker confidence | `Contact.verification` only | **Refactor** |
| ICP / user business profile | `BusinessProfile` exists, mostly unused | **Refactor** |

**Nothing needs replacing.** The bones are closer to the target than the feedback assumes —
evidence-with-provenance, deterministic-scoring-by-design, modular agents and cost
attribution were all in the original architecture. The gap is that the *middle* of the
pipeline was never built: discovery runs, outreach runs, and qualification between them is
a stage enum.

---

## A. Proposed architecture

Two loops, not one line. The existing agent runtime and adapter pattern stay; the new work
is a **stage machine** between discovery and outreach.

```
                            USER / ICP PROFILE
                                    │
                ┌───────────────────┴───────────────────┐
                ▼                                       ▼
        AUTONOMOUS MODE                          TARGET ACCOUNT
        (query strategist)                       (single company)
                │                                       │
                ▼                                       │
        DISCOVERY ENGINE ── serper / maps / overpass     │
                │                                       │
                ▼                                       │
        DEDUPLICATE  (domain → name fuzzy → AI tiebreak) │
                │                                       │
                ▼                                       │
        ┌─── TIER GATE ───┐  budget check, freshness check
        │                 │
        ▼                 ▼
   T1 ENRICH        (skip if fresh)
        │
        ▼
   T2 QUALIFY ──────► REJECTED (reason stored, not deleted)
        │
        ▼  (only survivors continue — this is the cost control)
   T3 RESEARCH ── website audit · news · signals · decision makers
        │                                       │
        └───────────────────┬───────────────────┘
                            ▼
                 COMPANY INTELLIGENCE PROFILE
                            │
                            ▼
                 SCORE  (deterministic, weighted, explainable)
                            │
                            ▼
                 OFFER ENGINE  (problem → opportunity → service)
                            │
                            ▼
                 CAMPAIGN GENERATOR  (observation → implication → offer → CTA)
                            │
                            ▼
                 HUMAN APPROVAL ──► SEND GATE ──► OUTREACH
                            │
                            ▼
                 RESPONSE TRACKING ──► OUTCOME ROLLUP ──┐
                            │                          │
                            └──── learning ────────────┘
                                     ↓
                        weights · ICP · query strategy
```

**The tier gate is the architecturally important part.** It is what stops the system
spending $0.10 researching a company that a $0.002 check would have rejected.

### Two principles carried forward

1. **The model never assigns the score.** It extracts features with evidence; arithmetic
   over configurable weights produces the number. Already an ADR; now actually built.
2. **No claim without provenance.** Already enforced in the scraper. Extended so *every*
   research output — signals, weaknesses, decision-makers — writes a `Claim` row, and
   anything unsourced is barred from outbound copy.

---

## B. Schema changes

Additive. No destructive migrations; existing tables keep working.

### New

```prisma
model CompanyProfile          // one per company, the intelligence view
  companyId, tierReached, lastEnrichedAt, lastResearchedAt
  websiteQuality Int?         // 0-100, measured not guessed
  onlinePresence Int?
  growthScore    Int?
  signalScore    Int?
  estimatedRevenueBand String?
  technologies   String[]
  socialProfiles Json
  googleRating   Float?
  googleReviews  Int?
  competitors    String[]
  services       String[]
  painPoints     Json         // [{ problem, evidence, claimId }]
  opportunities  Json
  freshness      Json         // per-field: { field: lastCheckedAt }

model Qualification           // the verdict, kept even when negative
  companyId, businessId, status  // QUALIFIED | REJECTED | PENDING | REVIEW
  grade String?                  // A | B | C
  score Int?
  rejectionReason RejectionReason?   // enum, 13 values
  rejectionNote String?
  factors Json                 // [{ factor, raw, weight, contribution, evidence, claimId }]
  decidedAt, scoringModelId

model ResearchRun             // what was researched, at what tier, for how much
  companyId, tier, agent, costUsd, serperCredits, sourcesUsed Json
  startedAt, finishedAt, status

model DecisionMaker           // separate from Contact: a person, not a mailbox
  companyId, fullName, jobTitle, seniority, department
  profileUrl, sourceUrl, sourceType
  confidence Float            // 0-1, never presented as certainty
  whyRelevant String          // why THIS person for THIS offer
  contactId String?           // linked when a real address exists

model Offer                   // what to sell this company, and why
  companyId, businessId
  problem, evidence, opportunity, recommendedService, reasoning
  fitScore Float, estimatedValue Decimal?
  sourceClaimIds String[]

model SearchQuery             // every query run, for cost and learning
  businessId, query, provider, resultsReturned, newCompanies, credits, ranAt

model IcpProfile              // extends BusinessProfile
  businessId, targetCountries, targetCities, targetIndustries
  excludedIndustries, sizeMin, sizeMax, dealMin, dealMax
  idealCharacteristics, disqualifiers, valueProposition
```

### Extended

- `Company` — `googleRating`, `googlePlaceId`, `foundedYear`, `estimatedRevenueBand`
- `BuyingSignal` — `impact` enum, `claimId` FK (forces evidence), `detectedBy`
- `Claim` — `claimType` enum so signals/weaknesses/firmographics share one evidence spine
- `AgentRun` — `researchRunId`, `tier`

### New enums

`QualificationStatus`, `RejectionReason` (13), `ResearchTier` (T1–T4), `SignalImpact`

---

## C. Agent workflow

Each stage is a typed function with defined input/output, running through the existing
`runAgent()` runtime — which already handles schema validation, refusal, cost and audit.

| Stage | Agent | Model | Deterministic part |
|---|---|---|---|
| Query strategy | `QueryStrategist` | Opus 5 | — |
| Deduplicate | *code* | — | domain → fuzzy name → AI only on ties |
| T1 Enrich | *code* + scraper | — | website audit is **measured**, not judged |
| T2 Qualify | `Qualifier` | Haiku 4.5 | **score computed in code** |
| T3 Research | `CompanyResearcher` | Sonnet 5 + web search | — |
| Signals | `SignalDetector` | Sonnet 5 | recency decay computed |
| Decision makers | `DecisionMakerFinder` | Sonnet 5 | confidence from source type |
| Offer | `OfferEngine` | Opus 5 | fit score computed |
| Campaign | `CampaignGenerator` | Opus 5 | claim validation post-hoc |

**Website quality should be measured, not asked.** Page weight, mobile viewport, form
presence, HTTPS, load time, structured data — all detectable by the scraper we already
have. A measured 0–100 beats a model's opinion, costs nothing, and is defensible in an
email: *"your quote page has no form"* is checkable.

---

## D. APIs and tools

| Need | Choice | Cost | Status |
|---|---|---|---|
| Search | **Serper** | $1/1k credits, 2,500 free | Wired |
| Maps/Places | **Serper `/places`** | same credits | Add — one adapter method |
| Web search fallback | Anthropic server-side | ~$0.05/call | Wired |
| Local businesses | Overpass | free | Wired |
| Website audit | **own scraper** | free | Extend |
| LLM | Anthropic (Opus/Sonnet/Haiku) | tiered | Wired |
| Email | Resend or Gmail | ~free at this volume | Adapter built, off |
| Sheets | Service account | free | Wired |

Deliberately **not** adding: Clearbit/ZoomInfo/Apollo (expensive, weak SG SME coverage),
LinkedIn scraping (against terms).

Serper Places is the single highest-value addition — it returns rating, review count,
address and phone for local trades, which is exactly the segment where web search is
weakest and where `googleRating` becomes a real qualification factor.

---

## E. Now versus later

**Phase 1 — Foundation (build now).** Schema above; the deterministic scorer that was
designed but never built; `Qualification` with rejection reasons; `ResearchRun` cost
capture; tier gate; ICP profile screen.
*Without this nothing else has anywhere to write.*

**Phase 2 — Intelligence.** Website audit (measured); Serper Places; signal detection with
mandatory `claimId`; company intelligence profile view; freshness-aware refresh.

**Phase 3 — Decision intelligence.** Decision-maker finder with confidence; offer engine;
why-now scoring; query strategist replacing hardcoded variants.

**Phase 4 — Outreach.** Research-driven personalisation (observation → implication → offer
→ CTA); campaign generator with tone and length; approval queue showing *why*.

**Phase 5 — Learning.** Outcome capture is mostly schema-ready. Wire the rollup, then
weight refitting with significance gating.

**Deliberately deferred:** ML ranking (needs hundreds of outcomes first), multi-tenant
auth, LinkedIn, autonomous sending.

---

## F. Cost per prospect

Measured, not estimated. Real numbers from this codebase's `AgentRun` rows:

- Serper: 24 credits → 86 companies = **$0.0003/company**
- Anthropic web search call: 26k–47k input tokens = **$0.05–0.10**
- Opus campaign generation: **$0.072** (measured)
- Sonnet classification (~5k in / 1k out): **$0.02**

| Tier | What | Per company |
|---|---|---|
| T1 Discover + enrich | Serper + scrape | **$0.003** |
| T2 Qualify | Haiku + computed score | **$0.005** |
| T3 Research | web search + signals + decision makers | **$0.15** |
| T4 Target account | deep, Opus | **$0.40** |

**Funnel economics** (the tier gate is what makes this work):

| Discovered | → Qualified | → Researched | → Campaigns | Total cost | Per campaign |
|---|---|---|---|---|---|
| 100 | 60 | 25 | 10 | **~$4.90** | $0.49 |
| 1,000 | 600 | 250 | 100 | **~$49** | $0.49 |
| 10,000 | 6,000 | 2,500 | 1,000 | **~$490** | $0.49 |

Without the gate — researching all 10,000 at T3 — the same run costs **$1,500+**. That
gate is worth roughly $1,000 per 10,000 prospects.

**Cost is not the binding constraint. Time is.** At ~20s per site crawl, 10,000 companies
is ~55 hours single-threaded. Concurrency and a job queue matter more than token savings.

---

## G. Biggest technical risks

**1. The decision-maker target may be unreachable.** Measured on real Singapore SMEs:
5 HVAC companies → 5 phones, 3 emails, **0 named staff**. The illustrative funnel assumes
19 of 86 with identifiable decision-makers. From public web sources in this segment that
looks optimistic. *Mitigation:* treat role inboxes as legitimate; make phone a first-class
channel; report decision-maker coverage honestly rather than inventing names.

**2. Buying signals are sparse for SMEs.** Funding rounds and expansion announcements are
enterprise phenomena. A 12-person aircon firm announces nothing. *Mitigation:* lean on
signals we can *measure* — website weaknesses, no mobile viewport, missing quote form,
stale copyright, Google review velocity. These are always available and always checkable.

**3. Evidence strictness fights personalisation coverage.** Strict evidence means most
companies yield nothing quotable, so emails fall back to generic. *Mitigation:* website
audit findings are self-generated evidence, available for every company with a site.

**4. PGlite will not survive this.** It already fell over twice under my test load, and
this design multiplies write volume. *Mitigation:* Neon migration is a connection-string
change; do it at Phase 2, not Phase 5.

**5. Serper is a single point of failure** — one vendor, prepaid credits, terms that could
change. *Mitigation:* the `SearchAdapter` interface already abstracts it; keep two live.

**6. The learning loop needs volume nobody has yet.** Response-rate differences between
industries need hundreds of sends before they mean anything. *Mitigation:* capture
correctly now, gate findings on sample size, never auto-refit weights.

**7. Scope.** This plan is roughly 4–6× the current codebase. The honest risk is building
Phases 1–3 well and never reaching outreach — where the revenue actually is.
*Mitigation:* phase gates with a working demo at each, and Phase 4 pulled forward if the
funnel is thin.

---

## Recommendation

Build Phase 1 now. It is the smallest change that makes the rest possible, and it closes
the gap I should have closed earlier — the scoring engine that was designed, documented,
and never implemented.

One deviation from the plan as given: **do the website audit in Phase 1, not Phase 2.**
It is free, it is measured rather than judged, and it is the only signal reliably available
for every company in this segment. Without it, qualification for SG SMEs has very little to
work with.
