import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { checkDraft } from "@/lib/outreach/quality";
import QuickEmail, { type Draft } from "./QuickEmail";
import { draftMore } from "./actions";

export const dynamic = "force-dynamic";

export default async function QuickEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status = "DRAFT" } = await searchParams;

  // DRAFT and PENDING_APPROVAL mean the same thing to a human: written, not
  // sent, waiting to be read. Two writers picked different values, so finished
  // emails sat invisible to this page. Treated as one bucket rather than
  // renaming a status other code depends on.
  const AWAITING = ["DRAFT", "PENDING_APPROVAL"] as const;
  const statusFilter = status === "DRAFT" ? { in: [...AWAITING] } : { equals: status };
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const policy = await db.sendPolicy.findUnique({ where: { businessId: business.id } });
  const isMock = (process.env.EMAIL_ADAPTER ?? "mock") === "mock";

  const [messages, counts, sentToday] = await Promise.all([
    db.message.findMany({
      where: { businessId: business.id, direction: "OUTBOUND", status: statusFilter as never, parentMessageId: null },
      orderBy: { createdAt: "desc" },
      take: 120,
      include: {
        contact: { include: { company: { select: { name: true, industry: true, websiteUrl: true, pinnedForEmailAt: true } } } },
        introduction: { include: { pairing: { select: { buyerIndustry: true } } } },
      },
    }),
    // Top-level messages only. Counting follow-ups here made the header say
    // "177 waiting" beside a list of 62 — the same page disagreeing with
    // itself, because a follow-up is not a thing you review and send.
    db.message.groupBy({
      by: ["status"],
      where: { businessId: business.id, direction: "OUTBOUND", parentMessageId: null },
      _count: { _all: true },
    }),
    db.sendLedgerEntry.count({
      where: { businessId: business.id, sentAt: { gte: new Date(Date.now() - 864e5) } },
    }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  const awaiting = (byStatus.DRAFT ?? 0) + (byStatus.PENDING_APPROVAL ?? 0);

  // The same mechanical checks the writer is held to, run here so a flagged
  // draft cannot look identical to a clean one in the list.
  const drafts: Draft[] = messages.map((m) => ({
    id: m.id,
    subject: m.subject ?? "",
    body: m.bodyText ?? "",
    company: m.contact?.company.name ?? "unknown company",
    email: m.contact?.email ?? null,
    industry: m.contact?.company.industry ?? null,
    websiteUrl: m.contact?.company.websiteUrl ?? null,
    words: (m.bodyText ?? "").split(/\s+/).filter(Boolean).length,
    status: m.status,
    blockedReason: m.blockedReason,
    violations: checkDraft(m.subject ?? "", m.bodyText ?? "").map((v) => v.detail),
    pitching: m.introduction?.pairing?.buyerIndustry ?? null,
    pinned: Boolean(m.contact?.company.pinnedForEmailAt),
  }))
    // A pin from the Leaks page is a human decision about what matters today,
    // so it outranks recency.
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Outreach · nothing sends without you</p>
        <h1>Quick Email</h1>
        <p className="sub">
          Read one, send one. Every send passes the compliance gate — sender identity, suppression list, and the
          Spam Control Act bulk thresholds — and approving sends immediately, so the read is the safeguard.
        </p>
      </div>

      {isMock && (
        <div className="notice" style={{ marginBottom: "1rem" }}>
          <strong>Nothing can leave this machine yet.</strong> <code>EMAIL_ADAPTER</code> is <code>mock</code>, so
          approving records the message and returns a fake id.
        </div>
      )}
      {!policy?.senderContactEmail && (
        <div className="notice" style={{ marginBottom: "1rem" }}>
          <strong>No reply-to address set.</strong> The gate blocks every send until one is configured — a working
          contact address is a legal requirement on commercial email, not a nicety.
        </div>
      )}

      <div className="stats" style={{ marginBottom: "1rem" }}>
        <div className="stat"><span className="v">{awaiting}</span><span className="l">Waiting to be read</span></div>
        <div className="stat good"><span className="v">{byStatus.SENT ?? 0}</span><span className="l">Sent</span></div>
        <div className="stat"><span className="v">{byStatus.BLOCKED_BY_GATE ?? 0}</span><span className="l">Blocked</span></div>
        <div className="stat">
          <span className="v">{sentToday}</span>
          <span className="l">Sent in 24h of {policy?.bulkPer24h ?? 100}</span>
        </div>
      </div>

      <p className="muted" style={{ fontSize: "0.82rem", marginTop: "-0.5rem" }}>
        Sending as <strong>{policy?.senderName}</strong> &lt;{policy?.senderContactEmail}&gt;. Past the{" "}
        {policy?.bulkPer24h ?? 100} threshold every message needs an <code>&lt;ADV&gt;</code> subject prefix by law.
      </p>

      <div className="lane-head" style={{ marginTop: "1.25rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {["DRAFT", "SENT", "BLOCKED_BY_GATE", "CANCELLED"].map((s) => (
            <a key={s} href={`/approvals?status=${s}`} className={s === status ? "chip on" : "chip"}>
              {s === "DRAFT" ? "waiting" : s.toLowerCase().replace(/_/g, " ")}{" "}
              ({s === "DRAFT" ? awaiting : byStatus[s] ?? 0})
            </a>
          ))}
        </div>
        {hasApiKey() && (
          <form action={draftMore.bind(null, business.id)} style={{ display: "flex", gap: "0.4rem" }}>
            <input type="hidden" name="limit" value="5" />
            <button type="submit" className="ghost">Draft 5 more</button>
          </form>
        )}
      </div>

      <QuickEmail businessId={business.id} drafts={drafts} isMock={isMock} />
    </>
  );
}
