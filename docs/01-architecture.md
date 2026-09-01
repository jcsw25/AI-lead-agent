# Architecture

## The shape of the thing

The spec asks for an AI Revenue Department, not an email generator. The difference is
architectural, not cosmetic. An email generator is a prompt with a text box. A revenue
department is a **loop that runs whether or not anyone opens the app**:

```
  business profile ──► ICP ──► discover ──► research ──► signals ──► score
        ▲                                                              │
        │                                                              ▼
   outcome stats ◄── revenue ◄── deals ◄── replies ◄── send ◄── draft ◄── value prop
```

Everything below exists to make that loop run continuously, cheaply, auditably, and
under human control until it earns autonomy.

---

## 1. Stack

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| Web | Next.js 15 (App Router) + React 19, TypeScript | Server Components let the dashboard read Postgres directly — no API tier for read paths. |
| API | Next.js Route Handlers + server actions | One deployable. Split out later only if a worker needs to scale independently. |
| DB | Postgres (Neon or Supabase) via Prisma | Chosen; see [ADR-004](06-decisions.md). |
| Queue | **pg-boss** on the same Postgres | No Redis, no Docker, no second service. Transactional enqueue: a job and the row it operates on commit together. |
| LLM | Anthropic TypeScript SDK | `claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5`, tiered by job — see §4. |
| Research | Anthropic **server-side web search** (`web_search_20260209`) | See §5. Removes the need for a separate search vendor at MVP. |
| Email | Adapter interface; `mock` → Gmail/Graph/Resend | See §6. |
| Validation | Zod, shared between agent I/O, API, and forms | One schema per concept, no drift. |

### Repository layout

```
revenue-agent/
├── prisma/schema.prisma          # the data model (validated)
├── docs/                         # you are here
└── src/
    ├── app/                      # Next.js routes + UI
    ├── agents/                   # one file per agent: schema in, schema out
    │   ├── runtime.ts            # THE shared execution path (§3)
    │   └── <agent>/{schema,prompt,index}.ts
    ├── engine/
    │   ├── scoring/              # deterministic scorer + weight fitting
    │   ├── signals/              # buying-trigger detection + expiry
    │   ├── gate/                 # compliance send gate (§7)
    │   └── dedupe/               # domain normalisation, entity resolution
    ├── jobs/                     # pg-boss handlers, one per queue
    ├── adapters/                 # email, search, calendar - interface + mock + real
    └── lib/                      # db, auth, crypto, money, dates
```

---

## 2. Tenancy and the shared knowledge graph

The single most consequential modelling decision:

- **`Company` and `Contact` are global**, deduped on registrable domain (eTLD+1).
- **`Prospect` is tenant-scoped** — it is *this business's pursuit of* that company,
  holding stage, score, owner and history.

Two customers both targeting the same hotel group research it **once**. Buying signals,
firmographics, and structure accrue to the shared graph; strategy, scoring, messaging and
relationship stay private to the tenant. Research cost per tenant falls as the platform
grows — the thing that gets better with scale.

The corollary is that isolation must be deliberate, not accidental:

- Every tenant-scoped query filters on `businessId`. Enforce with a Prisma client
  extension that **rejects at runtime** any query on a tenant-scoped model lacking a
  `businessId` filter. Do not rely on discipline.
- Suppression is enforced at two scopes (`BUSINESS`, `GLOBAL`) so one tenant's opt-out
  cannot leak another tenant's list, while a hard opt-out can bind everyone.
- Nothing tenant-authored (notes, campaign copy, deal values) ever enters the shared graph.

---

## 3. The agent runtime

Thirteen agents (spec §17), but **one execution path**. Every agent is:

```ts
type Agent<TIn, TOut> = {
  name: AgentName;
  model: ModelId;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  system: (ctx: Ctx) => string;   // stable prefix — cached
  user: (input: TIn) => string;   // volatile — after the cache breakpoint
  tools?: ToolDef[];
};
```

`runAgent()` is the only place that talks to the model, and it does seven things no
individual agent should reimplement:

1. **Validates input**, hashes it (`inputHash`) for dedupe and cache analysis.
2. **Opens an `AgentRun` row** before the call — so crashed runs are visible, not absent.
3. **Calls Claude** with `messages.parse()` + `zodOutputFormat(output)`, so the response
   is schema-valid or it is an error. No JSON-from-prose parsing anywhere in the codebase.
4. **Handles refusal**: `stop_reason: "refusal"` returns HTTP 200 — check it before
   reading content. Opus 5 calls carry `fallbacks: "default"` with beta
   `server-side-fallback-2026-07-01`.
5. **Records usage**: input/output/cache tokens, computed USD, latency, model, effort.
6. **Retries** on `RateLimitError`/5xx with jitter; marks `INVALID_OUTPUT` after N
   schema failures rather than looping forever.
7. **Closes the run** and returns `{ output, runId }`. The `runId` is stamped onto every
   record the agent produced — the audit trail spec §19 requires.

```ts
const res = await client.messages.parse({
  model: agent.model,
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  output_config: { effort: agent.effort ?? "high", format: zodOutputFormat(agent.output) },
  system: [{ type: "text", text: agent.system(ctx), cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: agent.user(input) }],
});
if (res.stop_reason === "refusal") { /* record + surface, do not retry blindly */ }
const out = res.parsed_output;   // null on parse failure — guard, don't assert
```

**Agents never call each other directly.** Composition happens through the job queue, so
every hop is resumable, observable, individually rate-limited, and independently retryable.
A discovery run that dies on company 40 of 200 resumes at 41.

### Prompt caching

Render order is `tools` → `system` → `messages`. The business profile, ICP definitions
and offering catalogue are a large stable prefix reused across hundreds of per-company
calls — put them in `system` behind one `cache_control` breakpoint, and put the volatile
per-company payload in `messages`. Never interpolate a timestamp or a per-request id into
the prefix; that silently invalidates it. Verify with `usage.cache_read_input_tokens` —
if it is zero across a batch, something is invalidating the prefix.

For a 300-company research run this is the difference between paying for the profile
prefix 300 times and paying for it once.

---

## 4. Model tiering

Not every job needs the same model. Assignment by judgment-density and volume:

| Agent | Model | Effort | Rationale |
|---|---|---|---|
| Business Analyst | `claude-opus-5` | high | Runs once per business. Everything downstream inherits its errors. |
| ICP | `claude-opus-5` | high | Open-ended reasoning; wrong ICPs waste every later dollar. |
| Strategy, Opportunity | `claude-opus-5` | high | Creative, low-volume, high-leverage. |
| Value Prop, Campaign | `claude-opus-5` | high | This is the product's voice. |
| Company Research | `claude-sonnet-5` | medium | High volume, retrieval-grounded — the sources do the work. |
| Signal extraction | `claude-sonnet-5` | medium | Narrow extraction against fetched text. |
| Conversation (reply classification) | `claude-haiku-4-5` | — | Narrow, high-volume, latency-sensitive. |
| Dedupe / normalisation | `claude-haiku-4-5` | — | Mechanical. |

Order-of-magnitude at 500 companies/month: all-Opus ≈ **$300–400**; tiered + cached +
batched ≈ **$40–60**. Same output quality where quality matters.

Bulk overnight work — re-scoring the pipeline, refreshing stale research, quarterly
signal sweeps — goes through the **Message Batches API at 50% cost**. It is asynchronous
by nature and nobody is waiting on it.

Every run writes its cost to `AgentRun.costUsd`, so per-business unit economics are a
query, not a guess. Add a per-business monthly spend cap early — the loop is autonomous
and an unbounded loop with a credit card is a bug class of its own.

---

## 5. Research: where facts come from

> Spec §20: *"Do not make the LLM responsible for factual data that can be retrieved
> from reliable external sources."*

That is a rule the architecture enforces, not a guideline it hopes for.

**Mechanism — the `Claim` table.** Research agents do not write to `Company` or
`Contact`. They emit `Claim` rows: `{ field, value, confidence, sourceUrl, sourceQuote,
observedAt, agentRunId }`. A separate deterministic promoter copies a claim onto the
canonical record only when it carries a source and beats what is already there. Consequences:

- Every firmographic on screen can show *where it came from* and *when*.
- `VerificationStatus.UNVERIFIED` facts **cannot raise a lead score** and **cannot appear
  in outbound copy**. Hallucinating "I saw you opened a new outlet" into a cold email is
  the failure mode that destroys trust in this product. It is blocked structurally.
- Facts expire. `expiresAt` demotes stale claims to `STALE` and re-queues research.

**Retrieval tooling.** Anthropic's server-side `web_search_20260209` + `web_fetch_20260209`
run on Anthropic's infrastructure — declared in `tools`, results returned as content
blocks, no separate vendor, no scraping infrastructure, and **one API key covers Phases
1–2**. Restrict per call with `allowed_domains` / `blocked_domains`.

Two traps: server-tool errors return **HTTP 200** with an error object in the result
block — branch on it, do not wrap in try/catch. And for `web_search`, a successful
`content` is a *list* while an error `content` is an *object* — check before indexing.

The `SearchAdapter` interface stays in place so a specialist vendor (Exa, Tavily) or a
licensed company-data provider can be added later where coverage justifies the cost. The
Singapore route to structured firmographics is ACRA/BizFile UEN data — worth it once
discovery volume is real, unnecessary before that.

---

## 6. Email adapters

```ts
interface EmailAdapter {
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  fetchSince(cursor: string | null): Promise<{ messages: InboundMessage[]; cursor: string }>;
  watch?(): Promise<void>;                    // push where available
}
```

Three implementations, in build order:

1. **`mock`** — writes to the DB, no network. The entire §24 demo runs end-to-end on this,
   including simulated replies. **Build this first**; it is what makes Phases 1–3
   developable and testable without any vendor.
2. **Gmail / Microsoft Graph** — OAuth. Required for the §10 inbox integration: sending
   *from the user's own mailbox* is what makes replies land in a real thread. Incremental
   sync via `historyId` / `deltaLink` stored on `Mailbox.historyCursor`; poll on a
   schedule first, add push (Pub/Sub, Graph subscriptions) later.
3. **Resend / Postmark** — bulk EDM only, where a dedicated sending domain and proper
   DKIM/SPF/DMARC matter more than thread continuity.

Deliverability is not an afterthought: per-mailbox daily caps, minimum spacing between
sends, warm-up ramp for new domains, and hard-bounce auto-suppression are all in the
schema (`Mailbox.dailySendCap`, `SendPolicy.minMinutesBetweenSends`, `SuppressionEntry`).
OAuth refresh tokens are encrypted at rest (envelope encryption, `Mailbox.credentialRef`
holds a key reference, never the token).

---

## 7. The send gate

Every outbound message — regardless of channel, campaign, or caller — passes through
**one function**. There is no other code path to the outside world.

```
sendGate(message) →
  1. suppression   BUSINESS + GLOBAL, by email hash and by domain
  2. provenance    contact is business contact info, from a recorded source
  3. consent       any explicit opt-out or prior negative reply on this thread
  4. channel rules DNC check for PHONE/SMS; region rules from ComplianceRule
  5. bulk test     rolling count in SendLedgerEntry for this contentGroupId
                   → crossing a threshold ⇒ apply <ADV> + unsubscribe, or block
  6. rate limits   mailbox daily cap, spacing, per-business cap
  7. approval      required unless autonomy level clears this action type
  8. commit        write Message, SendLedgerEntry, AuditLog in ONE transaction
```

A blocked message is not discarded — it is persisted with `status = BLOCKED_BY_GATE`
and `gateDecision` explaining which rule fired. Silent drops are undebuggable.

The legal reasoning behind steps 2, 4 and 5 is in [04-compliance.md](04-compliance.md).

---

## 8. Background work

pg-boss queues, all idempotent, all keyed so a retry cannot double-send:

| Queue | Trigger | Work |
|---|---|---|
| `business.analyse` | onboarding submit | Business Analyst → profile |
| `icp.generate` | profile ready | ICP Agent → ranked ICPs |
| `prospect.discover` | "Find Customers" / nightly | Hunter → candidate companies |
| `company.research` | new/stale company | Research Agent → Claims |
| `signal.sweep` | nightly + seasonal cron | Opportunity Agent → BuyingSignals |
| `prospect.score` | after research/signal change | deterministic scorer → ScoreSnapshot |
| `campaign.materialise` | campaign approved | expand recipients → draft Messages |
| `message.send` | schedule due | send gate → adapter |
| `inbox.sync` | every 2 min per mailbox | fetch → match thread → classify |
| `reply.classify` | inbound message | Conversation Agent → ReplyClass + draft |
| `stats.rollup` | nightly | OutcomeStat recompute |
| `recommendation.generate` | nightly | Strategy Agent → dashboard |

**Neon/Supabase note:** pg-boss needs the **direct** connection string (port 5432), not
the PgBouncer pooled one — hence `DIRECT_DATABASE_URL` in the schema. On Neon, either
disable autosuspend for the worker or accept cold-start latency on the first job.

Seasonal jobs are driven by `SeasonalWindow` rows, not a hardcoded calendar: the cron
asks "which windows in this business's region open within `buyingLeadDays`?" Adding
Australia is a seed file.

---

## 9. Autonomy

Spec §18 is a state machine, not a UI convention. `Business.autonomy` plus per-action
policy determines whether an `Approval` row is created and blocks execution:

| Level | Prospects | Campaign copy | First send | Replies |
|---|---|---|---|---|
| `MANUAL` | approve | approve | approve | approve |
| `APPROVE_EACH` *(default)* | approve batch | approve | approve each | approve each |
| `APPROVE_BATCH` | auto | approve | approve batch | approve each |
| `AUTOPILOT` | auto | approve | auto | auto, except NEGATIVE/UNSURE |

Two rules that never relax at any level: the send gate always runs, and anything
classified `NEGATIVE`, `UNSURE`, or `UNSUBSCRIBE` always escalates to a human.

Autonomy should be earned with evidence — approval rate, edit rate, complaint rate — and
those counters are already in `Approval` and `MessageEvent`.

---

## 10. What this architecture deliberately refuses to do

- **No LLM-assigned scores.** The model extracts features; arithmetic assigns the number.
  ([ADR-002](06-decisions.md))
- **No unsourced facts in outbound copy.** Structurally blocked, not prompt-discouraged.
- **No scraped personal data.** Business contact information from business sources only.
- **No "10,000 leads" button.** Discovery is capped per run and quality-gated — the
  bulk-threshold design in §7 makes volume spam legally and mechanically inconvenient
  by intent, which is exactly what spec §25 asks for.
