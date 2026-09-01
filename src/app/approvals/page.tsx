import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { approveAndSend, discardDraft, draftMore, regenerate, saveDraft } from "./actions";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status = "DRAFT" } = await searchParams;

  // DRAFT and PENDING_APPROVAL mean the same thing to a human: written, not
  // sent, waiting to be read. Two writers picked different values for it, so
  // four finished emails sat in the database invisible to this page. Treated as
  // one bucket rather than renaming a status other code already depends on.
  const AWAITING = ["DRAFT", "PENDING_APPROVAL"] as const;
  const statusFilter = status === "DRAFT" ? { in: [...AWAITING] } : { equals: status };
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const policy = await db.sendPolicy.findUnique({ where: { businessId: business.id } });
  const adapter = process.env.EMAIL_ADAPTER ?? "mock";
  const isMock = adapter === "mock";

  const [messages, counts, awaiting] = await Promise.all([
    db.message.findMany({
      where: { businessId: business.id, direction: "OUTBOUND", status: statusFilter as never },
      orderBy: { createdAt: "desc" },
      take: 40,
      include: {
        contact: { include: { company: { select: { id: true, name: true, industry: true, websiteUrl: true } } } },
        introduction: {
          include: { pairing: { select: { buyerIndustry: true, typicalDealLow: true, typicalDealHigh: true } } },
        },
      },
    }),
    db.message.groupBy({
      by: ["status"],
      where: { businessId: business.id, direction: "OUTBOUND" },
      _count: { _all: true },
    }),
    db.introduction.findMany({
      where: { businessId: business.id, outreachMessageId: null, status: { in: ["PROPOSED", "APPROVED"] } },
      select: { companyAId: true },
      distinct: ["companyAId"],
    }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  const awaitingCount = (byStatus.DRAFT ?? 0) + (byStatus.PENDING_APPROVAL ?? 0);
  const sentToday = await db.sendLedgerEntry.count({
    where: { businessId: business.id, sentAt: { gte: new Date(Date.now() - 864e5) } },
  });

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Outreach · nothing sends without you</p>
        <h1>Approval queue</h1>
        <p className="sub">
          One email per supplier, covering every buyer they were matched to. Read it, edit it if you want, then
          send. Every send also passes the compliance gate — sender identity, suppression list, and the Spam
          Control Act bulk thresholds.
        </p>
      </div>

      {isMock && (
        <div className="notice" style={{ marginBottom: "1rem" }}>
          <strong>Nothing can actually leave this machine yet.</strong> <code>EMAIL_ADAPTER</code> is{" "}
          <code>mock</code>, so &ldquo;send&rdquo; records the message and returns a fake id. Set{" "}
          <code>EMAIL_ADAPTER=resend</code> and <code>RESEND_API_KEY</code> in <code>.env</code> to send for real.
        </div>
      )}

      {!policy?.senderContactEmail && (
        <div className="notice" style={{ marginBottom: "1rem" }}>
          <strong>No reply-to address set.</strong> The gate will block every send until one is configured — a
          working contact address is a legal requirement on commercial email, not a nicety.
        </div>
      )}

      <div className="stats" style={{ marginBottom: "1.25rem" }}>
        <div className="stat"><span className="v">{awaitingCount}</span><span className="l">Awaiting review</span></div>
        <div className="stat good"><span className="v">{byStatus.SENT ?? 0}</span><span className="l">Sent</span></div>
        <div className="stat"><span className="v">{byStatus.BLOCKED_BY_GATE ?? 0}</span><span className="l">Blocked</span></div>
        <div className="stat"><span className="v">{awaiting.length}</span><span className="l">Suppliers not yet drafted</span></div>
      </div>

      <p className="muted" style={{ fontSize: "0.84rem", marginTop: "-0.75rem" }}>
        Sending as <strong>{policy?.senderName}</strong> &lt;{policy?.senderContactEmail}&gt; · {sentToday} sent in
        the last 24h of a {policy?.bulkPer24h ?? 100} bulk threshold. Past that, every message needs an{" "}
        <code>&lt;ADV&gt;</code> subject prefix by law.
      </p>

      <div className="lane-head" style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {["DRAFT", "SENT", "BLOCKED_BY_GATE", "CANCELLED"].map((s) => (
            <a key={s} href={`/approvals?status=${s}`} className={s === status ? "chip on" : "chip"}>
              {s === "DRAFT" ? "awaiting review" : s.toLowerCase().replace(/_/g, " ")}{" "}
              ({s === "DRAFT" ? awaitingCount : (byStatus[s] ?? 0)})
            </a>
          ))}
        </div>
        {hasApiKey() && awaiting.length > 0 && (
          <form action={draftMore.bind(null, business.id)} style={{ display: "flex", gap: "0.4rem" }}>
            <input type="hidden" name="limit" value="5" />
            <button type="submit">Draft 5 more</button>
          </form>
        )}
      </div>

      {messages.length === 0 ? (
        <div className="empty">
          <h3>Nothing here</h3>
          <p>
            {status === "DRAFT" && awaiting.length > 0
              ? `${awaiting.length} suppliers have an introduction but no email yet.`
              : "No messages with this status."}
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {messages.map((m) => {
            const company = m.contact?.company;
            const deal = m.introduction?.pairing;
            return (
              <div key={m.id} className="panel">
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                  <div>
                    <strong>{company?.name ?? "unknown company"}</strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      {m.contact?.email} · {company?.industry}
                      {company?.websiteUrl && (
                        <>
                          {" · "}
                          <a href={company.websiteUrl} target="_blank" rel="noopener noreferrer">site</a>
                        </>
                      )}
                    </div>
                  </div>
                  {deal && (
                    <div className="muted" style={{ fontSize: "0.78rem", textAlign: "right" }}>
                      pitching: {deal.buyerIndustry}
                      {deal.typicalDealLow && deal.typicalDealHigh && (
                        <div>deals ${Number(deal.typicalDealLow).toFixed(0)}–{Number(deal.typicalDealHigh).toFixed(0)}</div>
                      )}
                    </div>
                  )}
                </div>

                {m.blockedReason && (
                  <p className="notice" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
                    <strong>Blocked:</strong> {m.blockedReason}
                  </p>
                )}

                {m.status === "DRAFT" || m.status === "PENDING_APPROVAL" || m.status === "BLOCKED_BY_GATE" ? (
                  <form action={saveDraft.bind(null, business.id)} style={{ marginTop: "0.75rem" }}>
                    <input type="hidden" name="id" value={m.id} />
                    <label style={{ display: "block", fontSize: "0.78rem" }} className="muted">Subject</label>
                    <input name="subject" defaultValue={m.subject ?? ""} style={{ width: "100%" }} />
                    <label style={{ display: "block", fontSize: "0.78rem", marginTop: "0.5rem" }} className="muted">Body</label>
                    <textarea name="bodyText" defaultValue={m.bodyText ?? ""} rows={12} style={{ width: "100%", fontFamily: "inherit" }} />
                    <button type="submit" className="ghost" style={{ marginTop: "0.5rem" }}>Save edits</button>
                  </form>
                ) : (
                  <>
                    <p style={{ marginTop: "0.75rem" }}><strong>{m.subject}</strong></p>
                    <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "0.88rem" }}>{m.bodyText}</pre>
                    {m.sentAt && <p className="muted" style={{ fontSize: "0.78rem" }}>Sent {m.sentAt.toLocaleString()}</p>}
                  </>
                )}

                {(m.status === "DRAFT" || m.status === "PENDING_APPROVAL" || m.status === "BLOCKED_BY_GATE") && (
                  <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
                    <form action={approveAndSend.bind(null, business.id)}>
                      <input type="hidden" name="id" value={m.id} />
                      <button type="submit">{isMock ? "Approve (mock send)" : "Approve and send"}</button>
                    </form>
                    {hasApiKey() && (
                      <form action={regenerate.bind(null, business.id)}>
                        <input type="hidden" name="id" value={m.id} />
                        <button type="submit" className="ghost">Rewrite</button>
                      </form>
                    )}
                    <form action={discardDraft.bind(null, business.id)}>
                      <input type="hidden" name="id" value={m.id} />
                      <button type="submit" className="ghost">Discard</button>
                    </form>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
