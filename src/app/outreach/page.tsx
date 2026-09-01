import Link from "next/link";
import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { isLiveSending } from "@/adapters/email";
import { previewBatch } from "@/lib/gate";
import { draftBatch, discardDraft, retryBlocked, sendAllApproved } from "./actions";

export const dynamic = "force-dynamic";

export default async function OutreachPage() {
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const [readyToDraft, drafts, blocked, sentToday, policy] = await Promise.all([
    db.match.count({
      where: {
        businessId: business.id,
        status: { in: ["PROPOSED", "APPROVED"] },
        prospect: { stage: { notIn: ["SUPPRESSED", "LOST", "DISQUALIFIED", "WON"] }, contacts: { some: {} } },
        messages: { none: { direction: "OUTBOUND" } },
      },
    }),
    db.message.findMany({
      where: { businessId: business.id, direction: "OUTBOUND", status: "PENDING_APPROVAL" },
      include: { contact: { include: { company: true } }, match: { include: { product: { include: { supplier: true } } } } },
      orderBy: { createdAt: "asc" },
      take: 120,
    }),
    db.message.findMany({
      where: { businessId: business.id, status: "BLOCKED_BY_GATE" },
      include: { contact: { include: { company: true } } },
      take: 25,
    }),
    db.message.count({
      where: {
        businessId: business.id, direction: "OUTBOUND", status: "SENT",
        sentAt: { gte: new Date(Date.now() - 864e5) },
      },
    }),
    db.sendPolicy.findUnique({ where: { businessId: business.id } }),
  ]);

  const preview = drafts.length ? await previewBatch(business.id, drafts.map((d) => d.id)) : null;
  const live = isLiveSending();

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Outreach</p>
        <h1>Draft, review, send</h1>
        <p className="sub">
          Each email is written from that company&apos;s own match, trigger and contact. That is what makes them
          land — and it is also what keeps a hundred sends out of &ldquo;bulk&rdquo; territory, because the
          statute counts messages of the <i>same or similar subject matter</i>.
        </p>
      </div>

      {!live && (
        <div className="banner">
          <b>Sending is mocked.</b>
          <span>
            <code>EMAIL_ADAPTER=mock</code> — messages move through the real gate and get recorded, but nothing
            leaves this machine. <Link href="/settings">Connect a mailbox</Link> to send for real.
          </span>
        </div>
      )}
      {!hasApiKey() && (
        <div className="banner">
          <b>Copy is simulated.</b>
          <span>No <code>ANTHROPIC_API_KEY</code>, so drafts come from a template, not a model.</span>
        </div>
      )}

      <div className="stats" style={{ marginBottom: "1.5rem" }}>
        <div className="stat"><span className="v">{readyToDraft}</span><span className="l">Ready to draft</span></div>
        <div className="stat"><span className="v">{drafts.length}</span><span className="l">Awaiting approval</span></div>
        <div className="stat hot"><span className="v">{blocked.length}</span><span className="l">Blocked by gate</span></div>
        <div className="stat good"><span className="v">{sentToday}</span><span className="l">Sent (24h)</span></div>
        <div className="stat"><span className="v">{policy?.dailySendCap ?? "—"}</span><span className="l">Daily cap</span></div>
      </div>

      <h2>1 · Draft</h2>
      {readyToDraft === 0 ? (
        <p className="muted">
          Nothing waiting. Matched prospects with an identified contact appear here —{" "}
          <Link href="/prospects">find and match some</Link>.
        </p>
      ) : (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            <b>{readyToDraft}</b> matched {readyToDraft === 1 ? "company has" : "companies have"} a contact and no
            draft yet. Drafting runs one agent call per company, so each email is specific to them.
          </p>
          <div className="actions">
            {[25, 50, 100].map((n) => (
              <form key={n} action={draftBatch.bind(null, business.id, n)}>
                <button className="btn ghost" type="submit" disabled={readyToDraft === 0}>
                  Draft {Math.min(n, readyToDraft)}
                </button>
              </form>
            ))}
          </div>
        </div>
      )}

      <h2>2 · Review</h2>
      {preview && (
        <div className={preview.wouldTriggerAdv ? "banner err" : "banner"} style={{ marginBottom: "1rem" }}>
          <b>{preview.wouldTriggerAdv ? "This batch would count as bulk." : "Batch check passed."}</b>
          <span>
            {preview.total} drafts across <b>{preview.distinctGroups}</b> distinct subject-matter groups. Largest
            group: <b>{preview.largestGroup}</b> of {preview.limit} allowed in 24h.
            {preview.wouldTriggerAdv
              ? " Sending would require an <ADV> subject prefix on every message in that group. Vary the copy or split the send."
              : " Individually-tailored emails do not aggregate, so this stays out of bulk territory."}
          </span>
        </div>
      )}

      {drafts.length === 0 ? (
        <p className="muted">No drafts awaiting approval.</p>
      ) : (
        <>
          <div className="actions" style={{ marginBottom: "1rem" }}>
            <form action={sendAllApproved.bind(null, business.id)}>
              <button className="btn" type="submit">
                Approve &amp; send all {drafts.length}
              </button>
            </form>
            <span className="muted">
              Every message passes the gate individually: suppression, provenance, opt-outs, bulk threshold, caps.
            </span>
          </div>

          <div className="grid">
            {drafts.map((m) => (
              <article key={m.id} className="card play">
                <div className="play-top">
                  <div>
                    <h3>{m.contact?.company.name ?? "Unknown company"}</h3>
                    <span className="motion">
                      {m.contact?.fullName}
                      {m.contact?.jobTitle ? `, ${m.contact.jobTitle}` : ""} · {m.contact?.email}
                      {m.match ? ` · ${m.match.product.name}` : ""}
                      {m.match && !m.match.product.supplier.isSelf ? ` (via ${m.match.product.supplier.name})` : ""}
                    </span>
                  </div>
                </div>
                <p style={{ margin: 0 }}><b>Subject:</b> {m.subject}</p>
                <pre className="email">{m.bodyText}</pre>
                {m.classifierNotes && (
                  <div className="banner err" style={{ margin: 0 }}>
                    <b>Unverified claim.</b>
                    <span>{m.classifierNotes}</span>
                  </div>
                )}
                <div className="actions">
                  <form action={discardDraft.bind(null, m.id)}>
                    <button className="btn ghost" type="submit">Discard</button>
                  </form>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {blocked.length > 0 && (
        <>
          <h2>3 · Blocked by the gate</h2>
          <p className="muted" style={{ marginTop: "-.4rem" }}>
            Held, not discarded. The gate records exactly which rule fired, because &ldquo;why didn&apos;t that go
            out?&rdquo; is the first question anyone asks.
          </p>
          <div className="grid">
            {blocked.map((m) => (
              <article key={m.id} className="card play" style={{ borderLeftColor: "var(--crit)" }}>
                <div className="play-top">
                  <div>
                    <h3>{m.contact?.company.name ?? "Unknown"}</h3>
                    <span className="motion">{m.contact?.email}</span>
                  </div>
                </div>
                <p style={{ margin: 0, color: "var(--crit)" }}>{m.blockedReason}</p>
                <div className="actions">
                  <form action={retryBlocked.bind(null, m.id)}>
                    <button className="btn ghost" type="submit">Return to review</button>
                  </form>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
