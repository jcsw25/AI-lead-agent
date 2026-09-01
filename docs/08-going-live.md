# Going live

Three independent switches. Turn on real research without turning on real sending, and
send from a mock adapter while you tune copy. Nothing is all-or-nothing.

| | Switch | What changes |
|---|---|---|
| 1 | `ANTHROPIC_API_KEY` | Agents search the web and write real copy instead of samples |
| 2 | `EMAIL_ADAPTER` | Messages actually leave the machine |
| 3 | Sender identity | Legally required before any real send |

Check status any time at **`/settings`**.

---

## 1 · Real research and real companies

```bash
# .env
ANTHROPIC_API_KEY="sk-ant-..."
```

Restart the dev server. That's the whole change.

**What starts working.** The Prospect Hunter runs Anthropic's server-side web search and
returns companies that actually exist, with a source URL for each. The Industry Scout
reasons about your real market. The Matchmaker looks for real pain signals. Copy is
written rather than templated.

**What stays true.** The post-processor still discards any company with no source, so a
run that finds nothing returns nothing rather than inventing filler. That guard is
independent of the model.

**Cost.** At the tiering in [01-architecture.md §4](01-architecture.md), discovery and
matching for ~100 companies runs roughly **$3–6**. Every run records its own cost —
see `/runs`. Set `AGENT_MONTHLY_BUDGET_USD` before leaving anything on a schedule.

**Expect worse results than the mock at first.** Real discovery finds fewer companies with
verified contact emails than the sample data suggests, because most Singapore SMEs do not
publish named contacts. Role-based routes (`ops@`, `procurement@`) and LinkedIn are the
realistic fallback.

---

## 2 · Sending

### Option A — Resend (fastest)

```bash
EMAIL_ADAPTER="resend"
RESEND_API_KEY="re_..."
```

Verify your sending domain (SPF + DKIM) at resend.com first. ~10 minutes.

Good: full deliverability control, a domain you can burn without risking your main one,
clean separation from personal mail. Bad: replies go to that domain's inbox, and reply
detection needs an inbound webhook that isn't built yet.

### Option B — Gmail (better for cold outreach)

```bash
EMAIL_ADAPTER="gmail"
GOOGLE_CLIENT_ID="...apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="..."
```

Sends as you, from a real domain with real history, and replies land in your actual inbox
where the classifier can read them. For cold B2B that is worth more than any
deliverability trick.

**You do not need Google to verify the app.** Verification is for apps with outside users;
you are the only user:

1. Google Cloud Console → new project → enable the Gmail API.
2. OAuth consent screen → **External**, leave publishing status on **Testing**.
3. Add your own Google account under **Test users**.
4. Credentials → OAuth client ID → Web application → redirect URI
   `http://localhost:3000/api/auth/callback/google`.
5. Scopes: `gmail.send`, and `gmail.readonly` when you want reply detection.

Testing mode refresh tokens expire after 7 days, so you will re-consent weekly until you
publish. That is fine for one operator and avoids weeks of review.

**Not finished:** the adapter, token storage and send path are built; the OAuth consent
round-trip is not yet wired to a button. Until it is, Resend is the working route.

### Sending limits that are not the law

- Gmail: 500/day on a free account, 2,000/day on Workspace — hard caps.
- Reputation matters more than the cap. A new domain sending 100 cold emails on day one
  gets filtered regardless of content. Ramp: 10–20/day for the first week, then double
  weekly.
- `SendPolicy.dailySendCap` and `minMinutesBetweenSends` exist for this. Set them low and
  raise them.

---

## 3 · Sender identity

Set at `/settings`. Name, reply-to address, phone, postal address.

Not optional and not cosmetic: an unsolicited commercial electronic message must carry an
accurate, functional way to contact the sender. The gate appends this plus a one-click
unsubscribe to every message.

---

## Sending 100 at a time

This is the case worth understanding properly, because the naive version is unlawful.

**The rule.** Singapore's Spam Control Act deems messages "sent in bulk" above **100
messages of the same or similar subject matter in 24 hours** (1,000/30d, 10,000/yr). Bulk
unsolicited commercial email must carry an `<ADV>` prefix at the start of the subject line
plus a full unsubscribe facility with contact details. `<ADV>` will destroy your open rate.

**The consequence.** 100 emails from one template is one bulk campaign. 100 emails each
written from a different company's own trigger, contact and product are 100 separate
subject matters — and do not aggregate.

So the tailoring you asked for is not only what makes the emails work. It is the thing
that keeps the batch lawful without `<ADV>`.

**How the system enforces it.** Every send writes a `SendLedgerEntry` stamped with a
`contentGroupId` — a hash of the normalised subject and body with names, companies and
numbers stripped out. Identical templates collapse into one bucket; genuinely distinct
emails do not. Before you send, `/outreach` shows the split:

> 8 drafts across **8** distinct subject-matter groups. Largest group: **1** of 100
> allowed in 24h.

If a batch would cross, the default policy **blocks and tells you which group is too big**.
Switching `onThresholdCross` to `comply` sends anyway with `<ADV>` applied automatically —
that is EDM mode, and it should be a deliberate choice.

**Verified behaviour.** With the limit temporarily set to 2, the gate blocked the 3rd
identical message and let distinct ones through. Suppressed contacts and unsourced
contacts are blocked outright.

### The realistic workflow for 100

1. Accept 4–6 industry plays across different lanes (`/industries`).
2. Run discovery on each — 8–20 companies per play, capped per run.
3. Match products or services to all of them (`/prospects`).
4. `/outreach` → **Draft 100**. One agent call per company, so 100 genuinely different emails.
5. Check the batch panel: distinct groups should be close to the draft count. If it is
   far lower, the copy is too templated — that is a quality warning as much as a legal one.
6. Approve and send. The gate checks each one individually.

**Pacing.** 100 in one burst from a warm domain is fine legally and risky operationally.
`dailySendCap` is the control; start at 20.

---

## What is still missing

- Gmail OAuth consent flow wired to a button (adapter is built)
- Inbound sync and automatic reply classification — until then, **Log a reply** on a
  prospect moves the pipeline exactly as a live reply would
- Bounce and complaint webhooks feeding suppression automatically
- Scheduled follow-up sequences (the drafts exist; the scheduler does not)
