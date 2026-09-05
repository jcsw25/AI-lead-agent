import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { needCounts, probeQueue } from "@/lib/demand/needs";
import { seedNeeds } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_COPY: Record<string, { label: string; meaning: string; tone: string }> = {
  SUSPECTED: {
    label: "suspected",
    meaning: "Inferred from their industry. Nobody has asked. May never be quoted to a supplier.",
    tone: "lane-ADJACENT",
  },
  PROBED: { label: "asked", meaning: "The question went out. No answer yet.", tone: "lane-SEASONAL" },
  CONFIRMED: {
    label: "confirmed",
    meaning: "They wrote back and said it. This is the only status a supplier may be told about.",
    tone: "lane-TRIGGER",
  },
  FILLED: { label: "filled", meaning: "A supplier was introduced for it.", tone: "lane-TRIGGER" },
  DEAD: { label: "dead", meaning: "They said no, or the window closed.", tone: "lane-CONTRARIAN" },
};

/** Written as the buyer's own timing, since that is what it records. */
const URGENCY_COPY: Record<string, string> = {
  NOW: "wants it now",
  THIS_QUARTER: "has a date in mind",
  SOMEDAY: "open, no timing given",
  NOT_IN_MARKET: "not in the market",
};

export default async function NeedsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status = "SUSPECTED" } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const [needs, counts, categories] = await Promise.all([
    probeQueue(business.id, { status: status as never, limit: 60 }),
    needCounts(business.id),
    db.need.groupBy({ by: ["category"], where: { businessId: business.id }, _count: { _all: true } }),
  ]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const confirmed = counts.CONFIRMED ?? 0;
  const probed = counts.PROBED ?? 0;
  const replyRate = probed + confirmed > 0 ? Math.round((confirmed / (probed + confirmed)) * 100) : null;

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Demand · ask before you sell</p>
        <h1>Needs</h1>
        <p className="sub">
          What buyers have actually said they want. The system used to generate introductions on the assumption
          that buyers wanted things — nothing tested that. A need starts as a question, and only becomes
          quotable to a supplier once a human writes back.
        </p>
      </div>

      <div className="notice" style={{ marginBottom: "1.25rem" }}>
        <strong>Suspected is not evidence.</strong> Everything below in <em>suspected</em> is an inference from
        the company&rsquo;s industry — a reason to ask, never a fact to repeat. Only <em>confirmed</em> needs
        carry the reply that established them, and only those may be quoted to a supplier.
      </div>

      <div className="stats" style={{ marginBottom: "1.25rem" }}>
        <div className="stat"><span className="v">{counts.SUSPECTED ?? 0}</span><span className="l">To ask</span></div>
        <div className="stat"><span className="v">{probed}</span><span className="l">Asked</span></div>
        <div className="stat good"><span className="v">{confirmed}</span><span className="l">Confirmed</span></div>
        <div className="stat">
          <span className="v">{replyRate === null ? "—" : `${replyRate}%`}</span>
          <span className="l">Probe reply rate</span>
        </div>
      </div>

      <p className="muted" style={{ fontSize: "0.84rem", marginTop: "-0.75rem" }}>
        Probe reply rate is the number that decides whether this model works. Ask forty companies who handles
        something for them; if six answer, everything downstream is worth building. If none do, no amount of
        pairing logic saves it — and you found out for the price of forty emails.
      </p>

      <div className="lane-head" style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {["SUSPECTED", "PROBED", "CONFIRMED", "FILLED", "DEAD"].map((s) => (
            <a key={s} href={`/needs?status=${s}`} className={s === status ? "chip on" : "chip"}>
              {STATUS_COPY[s].label} ({counts[s] ?? 0})
            </a>
          ))}
        </div>
        <form action={seedNeeds.bind(null, business.id)}>
          <button type="submit" className="ghost">Rebuild from pairings</button>
        </form>
      </div>

      <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 1rem" }}>
        {STATUS_COPY[status]?.meaning}
      </p>

      {total === 0 ? (
        <div className="empty">
          <h3>No needs yet</h3>
          <p>Every pairing is a hypothesis about what a buyer wants. Turn them into questions worth asking.</p>
          <form action={seedNeeds.bind(null, business.id)}>
            <button type="submit">Build the probe queue</button>
          </form>
        </div>
      ) : needs.length === 0 ? (
        <div className="empty"><h3>Nothing at this status</h3></div>
      ) : status === "CONFIRMED" || status === "FILLED" ? (
        // A confirmed need is the only thing on this page a supplier is ever
        // shown, so it gets the whole quote rather than ninety characters of
        // one. What is on this card is what would be repeated to somebody else,
        // and it has to be readable in full before it is.
        <div style={{ display: "grid", gap: "1rem" }}>
          {needs.map((n) => {
            const c = n.company;
            return (
              <div key={n.id} className="panel">
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                  <div>
                    <strong>{c.name}</strong>
                    <div className="muted" style={{ fontSize: "0.78rem" }}>
                      {c.industry} · needs{" "}
                      <span className={`lane ${STATUS_COPY[n.status].tone}`}>{n.category}</span>
                    </div>
                  </div>
                  <div className="muted" style={{ fontSize: "0.78rem", textAlign: "right" }}>
                    {URGENCY_COPY[n.urgency] ?? n.urgency}
                    {n.confirmedAt && <div>confirmed {n.confirmedAt.toLocaleDateString()}</div>}
                  </div>
                </div>

                {n.verbatim ? (
                  <blockquote
                    style={{
                      margin: "0.85rem 0 0",
                      padding: "0.5rem 0 0.5rem 0.9rem",
                      borderLeft: "3px solid var(--accent, #7aa2f7)",
                      fontStyle: "italic",
                    }}
                  >
                    &ldquo;{n.verbatim}&rdquo;
                  </blockquote>
                ) : (
                  <p className="notice" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
                    Confirmed with no quote recorded. That should not be possible — do not repeat this to a
                    supplier until you have found the reply it came from.
                  </p>
                )}

                <div
                  className="muted"
                  style={{ fontSize: "0.8rem", marginTop: "0.6rem", display: "flex", gap: "1.25rem", flexWrap: "wrap" }}
                >
                  {n.incumbent && <span>currently uses <strong>{n.incumbent}</strong></span>}
                  {n.budgetHint && <span>budget mentioned: {n.budgetHint}</span>}
                  {c.contacts[0]?.email && <span>{c.contacts[0].email}</span>}
                  <span>{n.sourceMessageId ? "traced to their reply" : "no source message — do not quote this"}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Company</th><th>Might need</th><th>Contact</th><th>Grade</th><th>Confidence</th><th>Basis</th></tr>
              </thead>
              <tbody>
                {needs.map((n) => {
                  const c = n.company;
                  const email = c.contacts[0]?.email;
                  const findings = (c.siteAudit?.findings as string[] | null) ?? [];
                  return (
                    <tr key={n.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <div className="muted" style={{ fontSize: "0.76rem" }}>{c.industry}</div>
                      </td>
                      <td><span className={`lane ${STATUS_COPY[n.status].tone}`}>{n.category}</span></td>
                      <td style={{ fontSize: "0.8rem" }}>{email ?? <span className="muted">none</span>}</td>
                      <td>{c.qualifications[0]?.grade ?? "—"}</td>
                      <td className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {Math.round(n.confidence * 100)}%
                      </td>
                      <td className="muted" style={{ fontSize: "0.78rem", maxWidth: "22rem" }}>
                        {n.verbatim ? <em>&ldquo;{n.verbatim.slice(0, 90)}&rdquo;</em> : n.notes?.slice(0, 90)}
                        {findings.length > 0 && n.status === "SUSPECTED" && (
                          <div style={{ marginTop: "0.2rem" }}>seen on their site: {findings[0].slice(0, 60)}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="lane-head" style={{ marginTop: "2rem" }}><h2>By category</h2></div>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {categories
              .sort((a, b) => b._count._all - a._count._all)
              .map((c) => (
                <span key={c.category} className="chip">
                  {c.category} ({c._count._all})
                </span>
              ))}
          </div>
        </>
      )}
    </>
  );
}
