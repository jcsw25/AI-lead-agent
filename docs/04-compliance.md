# Compliance architecture (Singapore first)

> **Not legal advice.** This documents the rules the system enforces and the sources they
> come from, so a lawyer can review the *design* rather than the codebase. Have Singapore
> counsel confirm before the first real send. The statutory thresholds are configurable
> (`SendPolicy`) precisely because they are subject to change by Gazette order.

Two separate Singapore regimes apply. Conflating them is the usual mistake.

---

## 1. PDPA — why B2B prospecting is lawful here

The Personal Data Protection Act's data protection provisions **do not apply to business
contact information**: an individual's name, position or title, business telephone number,
business address, business email address, and similar professional details — provided
they were given for a business purpose rather than a purely personal one.

This exclusion is the legal foundation of the entire product. Consequences the schema
enforces:

| Requirement | Enforcement |
|---|---|
| Only business contact information | `Contact.isBusinessContactInfo`; personal Gmail/Hotmail addresses flagged and excluded from the gate unless the user attests a business context |
| Provenance for every contact | `Contact.sourceUrl` + `sourceType`; no source ⇒ `UNVERIFIED` ⇒ the gate refuses to send |
| Business purpose only | Contacts are usable only inside a `Prospect` for the business they were discovered for |
| Deletion on request | `SuppressionEntry` stores a **hash** as well as raw values, so erasing a `Contact` never resurrects them |

What the exclusion does **not** cover: consumer personal data. The moment the product
supports B2C (spec §2 lists gift buyers, couples, seasonal shoppers), full PDPA consent,
purpose-limitation and notification obligations apply. **B2C outreach is a different
compliance mode, not a bigger list** — treat it as a separate build with its own gate
rules, and do not let a B2C ICP silently reuse the B2B send path.

## 2. Do Not Call Registry — phone, SMS, fax only

The DNC provisions (PDPA Part 9) cover marketing messages sent to **Singapore telephone
numbers** — voice, SMS, fax. They do **not** cover email.

Spec §8 includes phone scripts. The moment the system creates a call task or an SMS, a
DNC check is required before contact. Modelled as `ComplianceRule` key
`dnc_check_required` per region + channel; `SuppressionReason.DNC_REGISTRY` records the
result. Until a DNC checking route exists, the gate should **hard-block** `PHONE` and
`WHATSAPP` channels — build the scripts, do not automate the dialling.

---

## 3. Spam Control Act 2007 — the bulk threshold, and the design it drives

This is the rule that shapes the product, so it is worth stating precisely.

**Messages are deemed "sent in bulk" when a sender sends, causes to be sent, or
authorises the sending of messages containing the same or similar subject matter above
any of:**

| Window | Threshold |
|---|---|
| 24 hours | more than **100** messages |
| 30 days | more than **1,000** messages |
| 1 year | more than **10,000** messages |

Unsolicited commercial electronic messages **sent in bulk** must comply with the Second
Schedule, which requires:

- `<ADV>` — the letters, followed by a space, at the **start of the subject line** (or, if
  there is no subject field, as the first words of the message)
- a subject title that is not false or misleading as to the content
- header information that is not false or misleading
- an accurate, functional email address or telephone number for contacting the sender
- a working **unsubscribe facility**, which must itself carry an email address and a
  telephone or fax number for submitting the request

The Act covers email, SMS and fax.

### The architectural consequence

Below the bulk threshold, individually-researched B2B emails are not "sent in bulk" and
the Second Schedule's `<ADV>` requirement is not triggered. Above it, `<ADV>` is mandatory
— and an `<ADV>`-prefixed subject line will gut open rates.

**So the statute and spec §25 ("Accuracy > quantity", "Relevance > volume") point at the
same design.** The compliance boundary is not a nuisance to route around; it is the
product's operating envelope. The system is built to stay deliberately under it:

```
sendGate step 5 — bulk evaluation
  count = SendLedgerEntry
            .where(businessId, contentGroupId, sentAt > now - window)
            .count()   for each of the 24h / 30d / 365d windows

  if every count + 1 <= threshold        → send as an individual message
  if any count + 1 > threshold:
     policy "block"  (default)           → hold, alert: "this crosses the bulk
                                            threshold — split, re-target, or
                                            switch this campaign to EDM mode"
     policy "comply" (explicit EDM)      → apply <ADV> prefix + unsubscribe block
                                            + sender contact details, then send
```

`contentGroupId` is the "same or similar subject matter" bucket: a hash of the normalised
subject and body template, so genuinely individualised messages land in different buckets
while one blasted template lands in one. `SendLedgerEntry` is append-only and holds a
salted recipient hash rather than an address, so the counting ledger is not itself a
second copy of the contact database.

Two sending modes fall out of this, and the UI should name them:

| | **Individual outreach** (default) | **EDM / bulk** (explicit opt-in) |
|---|---|---|
| Volume | under threshold, enforced | any |
| Subject | as written | `<ADV> ` prefixed automatically |
| Unsubscribe | included (good practice) | mandatory, with contact details |
| Approval | per message | per campaign |
| Channel | user's own mailbox | dedicated sending domain |

A user who wants to blast 5,000 emails can — in EDM mode, with `<ADV>`, having seen what
that means. What they cannot do is drift into bulk sending accidentally.

---

## 4. Always-on rules (independent of volume)

Applied to every outbound message regardless of threshold:

1. **Unsubscribe in every message.** `SendPolicy.alwaysIncludeUnsubscribe` defaults true.
   One-click, no login, honoured immediately by writing a `SuppressionEntry` before the
   confirmation renders.
2. **Real sender identity.** Business name, a monitored reply-to, and a postal address.
   No misleading headers or subjects.
3. **Suppression checked at send time**, not at list-build time. A person who opts out
   between drafting and sending must not receive the message.
4. **Hard bounces auto-suppress**; complaints suppress `GLOBAL`.
5. **Every send writes an `AuditLog` row** — who, what, when, which gate decision, which
   agent run produced the copy.
6. **Reply classified `UNSUBSCRIBE` ⇒ immediate suppression**, before any drafting, and
   never auto-replied to.

---

## 5. Data subject rights

| Right | Implementation |
|---|---|
| Access | export all `Contact` + `Message` + `Activity` for an identifier |
| Correction | edit `Contact`; supersede the underlying `Claim`, keeping history |
| Withdrawal | `SuppressionEntry`, effective immediately at the gate |
| Deletion | delete `Contact` and its `Claim`s; **retain the hashed suppression entry** and the `AuditLog` — you must keep enough to honour the opt-out and to prove you did |

The tension between erasure and suppression is why suppression stores hashes: the system
can prove "we must not contact this address" without retaining the address in the
contact graph.

---

## 6. Extending beyond Singapore

`ComplianceRule` rows are keyed by `(regionId, channel, key)`, so a new market is a seed
file plus a gate rule — not a refactor. The gate reads rules for the **prospect's** region,
not the sender's. Known shape of the next markets:

- **Australia** — Spam Act 2003: consent (express or inferred) is required, which is a
  materially stricter regime than Singapore's. Inferred consent from a published business
  address exists but is narrow. Do not assume the Singapore model ports.
- **EU/UK** — GDPR/PECR: legitimate interest is arguable for B2B, but demands a balancing
  assessment, and DPIA-style records. `Claim` provenance already supplies most of the
  evidence trail this needs.

Each new region needs its own legal review before its first send. The architecture makes
that a bounded task — one rule set, one seed, one gate test suite — rather than an audit
of the whole codebase.

---

## Sources

- [Spam Control Act 2007 — Singapore Statutes Online](https://sso.agc.gov.sg/Act/SCA2007)
- [Spam Control Act 2007 (PDF, full text incl. Second Schedule)](https://sso.agc.gov.sg/Act/SCA2007?ViewType=Pdf&_=20240903135436)
- [Personal Data Protection Act 2012 — Singapore Statutes Online](https://sso.agc.gov.sg/Act/PDPA2012)
- [The Spam Control Act 2007 — Singapore Journal of Legal Studies](https://law.nus.edu.sg/sjls/wp-content/uploads/sites/14/2024/07/1943-2007-sjls-dec-361.pdf)
- [GDPR matchup: Singapore's Personal Data Protection Act — IAPP](https://iapp.org/news/a/gdpr-matchup-singapores-personal-data-protection-act)
- [PDPA compliance in Singapore — Hawksford](https://www.hawksford.com/insights-and-guides/pdpa-compliance-in-singapore)
