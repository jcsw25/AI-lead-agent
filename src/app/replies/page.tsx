import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { checkForReplies } from "./actions";

export const dynamic = "force-dynamic";

/** How a reply class should read and colour on screen. */
const CLASS_META: Record<string, { label: string; tone: string }> = {
  HOT: { label: "Interested", tone: "good" },
  WARM: { label: "Warm", tone: "good" },
  COLD: { label: "Lukewarm", tone: "" },
  NEGATIVE: { label: "Not interested", tone: "bad" },
  UNSUBSCRIBE: { label: "Asked to be removed", tone: "bad" },
  AUTO_REPLY: { label: "Auto-reply", tone: "muted" },
  OUT_OF_OFFICE: { label: "Out of office", tone: "muted" },
  BOUNCE: { label: "Bounced", tone: "bad" },
  WRONG_CONTACT: { label: "Wrong person", tone: "" },
  UNSURE: { label: "Needs a human", tone: "" },
};

const ago = (d: Date) => {
  const h = Math.floor((Date.now() - d.getTime()) / 36e5);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

export default async function RepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter = "all" } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const sent = await db.message.findMany({
    where: { businessId: business.id, direction: "OUTBOUND", status: "SENT" },
    orderBy: { sentAt: "desc" },
    include: {
      contact: { select: { email: true, fullName: true, company: { select: { id: true, name: true, industry: true } } } },
      introduction: { select: { companyB: { select: { name: true } }, pairing: { select: { buyerIndustry: true } } } },
    },
  });

  // The inbound side, keyed so each sent email can find its answer.
  const inbound = await db.message.findMany({
    where: { businessId: business.id, direction: "INBOUND" },
    orderBy: { repliedAt: "desc" },
    select: {
      id: true, bodyText: true, subject: true, replyClass: true, repliedAt: true,
      providerThreadId: true, contactId: true, classifierNotes: true,
    },
  });
  const byThread = new Map(inbound.filter((i) => i.providerThreadId).map((i) => [i.providerThreadId!, i]));
  const byContact = new Map<string, typeof inbound[number]>();
  for (const i of inbound) if (i.contactId && !byContact.has(i.contactId)) byContact.set(i.contactId, i);

  const rows = sent.map((m) => {
    const reply =
      (m.providerThreadId && byThread.get(m.providerThreadId)) ||
      (m.repliedAt && m.contactId ? byContact.get(m.contactId) : undefined) ||
      null;
    return { m, reply };
  });

  const replied = rows.filter((r) => r.m.repliedAt);
  const waiting = rows.filter((r) => !r.m.repliedAt);
  const interested = replied.filter((r) => r.reply?.replyClass === "HOT" || r.reply?.replyClass === "WARM");

  const shown =
    filter === "replied" ? replied
    : filter === "waiting" ? waiting
    : filter === "interested" ? interested
    : rows;

  const rate = sent.length ? Math.round((replied.length / sent.length) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Outreach · what came back</p>
        <h1>Replies</h1>
        <p className="sub">
          Every email that actually went out, and whether it was answered. Replies are pulled from the connected
          mailbox and matched to the specific email they answer, so the reply rate below is a real number rather
          than an estimate.
        </p>
      </div>

      <div className="stats" style={{ marginBottom: "1.25rem" }}>
        <div className="stat"><span className="v">{sent.length}</span><span className="l">Sent</span></div>
        <div className="stat good"><span className="v">{replied.length}</span><span className="l">Replied</span></div>
        <div className="stat good"><span className="v">{interested.length}</span><span className="l">Interested</span></div>
        <div className="stat"><span className="v">{rate}%</span><span className="l">Reply rate</span></div>
      </div>

      <div className="lane-head">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {[
            { k: "all", label: `all (${rows.length})` },
            { k: "replied", label: `replied (${replied.length})` },
            { k: "interested", label: `interested (${interested.length})` },
            { k: "waiting", label: `no reply yet (${waiting.length})` },
          ].map((f) => (
            <a key={f.k} href={`/replies?filter=${f.k}`} className={filter === f.k ? "chip on" : "chip"}>
              {f.label}
            </a>
          ))}
        </div>
        <form action={checkForReplies.bind(null, business.id)}>
          <button type="submit">Check for replies</button>
        </form>
      </div>

      {sent.length === 0 ? (
        <div className="empty">
          <h3>Nothing sent yet</h3>
          <p>Approve a draft in the <a href="/approvals">approval queue</a> and it will appear here.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty"><h3>Nothing in this view</h3></div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {shown.map(({ m, reply }) => {
            const meta = reply?.replyClass ? CLASS_META[reply.replyClass] : null;
            const hasReply = Boolean(m.repliedAt);
            return (
              <div
                key={m.id}
                className="panel"
                style={{ borderLeft: `3px solid var(--${hasReply ? "good" : "rule"}, ${hasReply ? "#2d6a44" : "#333"})` }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                  <div>
                    <strong>
                      {hasReply ? "✓ " : ""}
                      {m.contact?.company.name ?? "unknown"}
                    </strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      {m.contact?.email}
                      {m.contact?.company.industry ? ` · ${m.contact.company.industry}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: "0.8rem" }}>
                    {hasReply ? (
                      <span className={meta?.tone === "bad" ? "bad" : "good"}>
                        <b>{meta?.label ?? "Replied"}</b>
                      </span>
                    ) : (
                      <span className="muted">no reply yet</span>
                    )}
                    <div className="muted">sent {m.sentAt ? ago(m.sentAt) : ""}</div>
                  </div>
                </div>

                <p style={{ margin: "0.6rem 0 0", fontSize: "0.9rem" }}>
                  <b>{m.subject}</b>
                </p>

                {hasReply && reply ? (
                  <div
                    style={{
                      marginTop: "0.6rem",
                      padding: "0.7rem 0.9rem",
                      background: "var(--alt, rgba(255,255,255,0.04))",
                      borderRadius: 4,
                    }}
                  >
                    <div className="muted" style={{ fontSize: "0.74rem", marginBottom: "0.3rem" }}>
                      They replied {reply.repliedAt ? ago(reply.repliedAt) : ""}
                      {m.sentAt && reply.repliedAt
                        ? ` · ${Math.max(1, Math.round((reply.repliedAt.getTime() - m.sentAt.getTime()) / 36e5))}h after sending`
                        : ""}
                      {reply.replyClass === "UNSURE" ? " · the classifier could not read this one, worth a look" : ""}
                    </div>
                    <div style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>
                      {(reply.bodyText ?? "").slice(0, 400)}
                      {(reply.bodyText ?? "").length > 400 ? "…" : ""}
                    </div>
                  </div>
                ) : (
                  <p className="muted" style={{ fontSize: "0.82rem", margin: "0.5rem 0 0" }}>
                    No response yet. Replies arrive in {business.name}&rsquo;s connected mailbox and appear here
                    once checked.
                  </p>
                )}

                <details style={{ marginTop: "0.6rem" }}>
                  <summary style={{ cursor: "pointer", fontSize: "0.8rem" }} className="muted">
                    What was sent
                  </summary>
                  <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "0.85rem" }}>
                    {m.bodyText}
                  </pre>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
