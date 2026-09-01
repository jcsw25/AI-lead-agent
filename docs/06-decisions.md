# Architecture decisions

Each records a choice, the alternative rejected, and what would make us revisit it.

---

## ADR-001 — Global company graph, tenant-scoped prospects

**Decision.** `Company` and `Contact` are global canonical records deduped on registrable
domain. `Prospect` is the tenant-scoped pursuit of a company.

**Rejected:** per-tenant company copies (simpler isolation, trivially correct privacy).

**Why.** Research is the expensive operation. Copies mean paying for the same hotel group
N times and holding N divergent versions of the truth. The shared graph makes marginal
research cost fall as tenants grow, and buying signals — genuinely public facts — accrue
once.

**Cost accepted.** Isolation becomes deliberate work: a Prisma extension that rejects
tenant-scoped queries without a `businessId` filter, two-scope suppression, and a rule
that no tenant-authored content ever enters the shared graph.

**Revisit if** a customer requires contractual data isolation. Mitigation without a
rewrite: a `Company.private = true` partition for that tenant.

---

## ADR-002 — The LLM never assigns the lead score

**Decision.** The model extracts features it alone can judge (industry fit, need fit,
accessibility) with evidence. A deterministic weighted sum over those plus database facts
produces the 0–100.

**Rejected:** asking the model for a score and an explanation.

**Why.** Three reasons, each sufficient:

1. **Reproducibility.** The same prospect must score the same twice. Sales teams lose
   confidence fast when the number moves for no reason.
2. **Explainability.** Spec §7 demands the score be explained. A model's post-hoc
   rationalisation of "92" is not an explanation; a factor table is.
3. **Learnability.** Spec §16 demands the system learn from outcomes. You can refit
   weights against conversion data. You cannot refit a vibe.

**Cost accepted.** Weights need an initial hand-set version, and features must be
enumerated up front rather than emerging from the model.

**Revisit if** the factor list stops capturing what predicts conversion — the fix is a
learned model over the same features, still deterministic at inference.

---

## ADR-003 — Facts come from retrieval, with provenance, or they don't count

**Decision.** Research agents emit `Claim` rows carrying `sourceUrl`, `sourceQuote`,
`observedAt`. A deterministic promoter writes canonical fields. Unverified facts cannot
raise a score and cannot appear in outbound copy.

**Rejected:** letting the model state firmographics directly (much less code).

**Why.** Spec §20 says so, and the failure mode is fatal to the product: an email
asserting a fabricated funding round or outlet opening does more damage to the customer's
reputation than a hundred unsent emails cost them. Cold outreach makes the model's
mistakes public, in the customer's name, permanently.

**Cost accepted.** More rows, a promotion step, and slower research.

---

## ADR-004 — Hosted Postgres, pg-boss for jobs

**Decision.** Neon or Supabase Postgres; pg-boss for the queue on the same database.

**Rejected:** Redis + BullMQ (another service to run); Inngest/Trigger.dev (another
vendor, another bill, at this stage).

**Why.** No Docker or local Postgres on this machine, and the queue's job volume is small
and bursty — well inside what Postgres handles. Transactional enqueue is a real benefit:
the job and the row it operates on commit together, so there is no "job fired for a record
that rolled back".

**Operational note.** pg-boss needs the **direct** connection (`:5432`), not the pooled
PgBouncer endpoint — hence `directUrl` in the schema. On Neon, expect cold-start latency
on the first job after autosuspend, or keep the worker warm.

**Revisit at** sustained high job volume, or when workers need to scale independently of
the web app.

---

## ADR-005 — Anthropic server-side web search as the MVP research tool

**Decision.** Use `web_search_20260209` / `web_fetch_20260209` behind a `SearchAdapter`
interface.

**Rejected:** Tavily/Exa/Serper as a primary dependency from day one.

**Why.** One API key gets the whole product to end of Phase 2. Search runs on Anthropic's
infrastructure — no scraping stack, no proxy pool, no second contract. The adapter
interface means swapping in a specialist later is a file, not a refactor.

**Revisit when** discovery volume makes a bulk company-data provider cheaper per record,
or when Singapore firmographic coverage (ACRA/BizFile UEN data) becomes the bottleneck.

---

## ADR-006 — One send gate, no bypass

**Decision.** Every outbound message passes one function performing suppression,
provenance, consent, channel rules, bulk-threshold evaluation, rate limits, approval, and
transactional commit. Blocked messages persist with the reason.

**Rejected:** compliance checks at campaign build time.

**Why.** List-build-time checks are wrong by construction — someone who opts out between
drafting and sending would still be emailed. And a single choke point is the only design
where "can this system spam someone?" has a short, auditable answer.

**Cost accepted.** Every send path must route through it, including future channels. That
constraint is the point.

---

## ADR-007 — Deliberately staying under the bulk threshold

**Decision.** Default policy blocks sends that would cross the Spam Control Act bulk
thresholds and prompts the user to narrow targeting; `<ADV>` compliance mode is an
explicit opt-in for EDM campaigns.

**Rejected:** always applying `<ADV>` (kills open rates), or ignoring the thresholds
(unlawful once volume grows).

**Why.** The statutory line and spec §25's "Accuracy > quantity" fall in the same place.
Making bulk mode a deliberate, visible choice means the default product is the one the
spec actually asked for. See [04-compliance.md §3](04-compliance.md).

---

## ADR-008 — Model tiering with batch for bulk

**Decision.** Opus 5 for judgment (analysis, ICP, strategy, copy), Sonnet 5 for
retrieval-grounded volume (research, extraction), Haiku 4.5 for narrow classification.
Batch API for overnight bulk work.

**Rejected:** one model everywhere (simpler).

**Why.** Roughly 6–8× cost difference at equal output quality, because the expensive
capability is only needed where judgment is. Company research is bounded by the quality
of its sources, not the model's reasoning.

**Revisit** by measurement, not intuition: `AgentRun` records model, cost and outcome per
run, so tier changes can be A/B'd against reply rate rather than argued about.

---

## ADR-009 — Autonomy is a state machine with earned escalation

**Decision.** Four levels from `MANUAL` to `AUTOPILOT`, per-action approval policy,
`Approval` rows that block execution. Two rules never relax: the send gate always runs,
and `NEGATIVE`/`UNSURE`/`UNSUBSCRIBE` replies always escalate.

**Rejected:** a global "automation on/off" toggle.

**Why.** Spec §18 wants approval now and automation later for trusted workflows. Trust is
per-workflow, not global — a business may happily auto-send follow-up #2 while wanting
every first-touch reviewed. Modelling it as levels plus per-action policy means the
progression is configuration, and the evidence for granting it (approval rate, edit rate,
complaint rate) is already recorded.
