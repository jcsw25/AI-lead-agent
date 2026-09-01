import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { findMatches, setMatchStatus } from "./actions";

export const dynamic = "force-dynamic";

const pct = (n: number) => `${Math.round(n * 100)}%`;

export default async function MatchmakePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string }>;
}) {
  const { status = "PROPOSED", sort = "novelty" } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const matches = await db.matchmake.findMany({
    where: { businessId: business.id, ...(status === "ALL" ? {} : { status: status as never }) },
    orderBy: sort === "confidence" ? { confidence: "desc" } : { novelty: "desc" },
    take: 60,
    include: {
      companyA: { select: { name: true, industry: true, websiteUrl: true, contacts: { select: { email: true } } } },
      companyB: { select: { name: true, industry: true, websiteUrl: true, contacts: { select: { email: true } } } },
    },
  });

  const counts = await db.matchmake.groupBy({
    by: ["status"],
    where: { businessId: business.id },
    _count: { _all: true },
  });
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  const total = counts.reduce((s, c) => s + c._count._all, 0);

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Matchmaking · both sides must gain</p>
        <h1>Matchmake</h1>
        <p className="sub">
          The agent reads the companies actually in the database and argues for specific pairs. This runs the
          opposite way to Introductions, which apply an industry thesis mechanically — here the model looks at
          two real companies and makes the case for that pair, including combinations no industry pairing would
          produce.
        </p>
      </div>

      <div className="notice" style={{ marginBottom: "1.25rem" }}>
        <strong>Every match has to work in both directions.</strong> A one-sided match is a sales lead with
        better manners: one party gains, the other pays. Two-sided value is what makes both of them glad you
        called — and the only reason either takes your next introduction. Each card below states what A gets and
        what B gets, separately.
      </div>

      <div className="stats" style={{ marginBottom: "1.25rem" }}>
        <div className="stat"><span className="v">{total}</span><span className="l">Proposed</span></div>
        <div className="stat good"><span className="v">{byStatus.SHORTLISTED ?? 0}</span><span className="l">Shortlisted</span></div>
        <div className="stat muted"><span className="v">{byStatus.DISMISSED ?? 0}</span><span className="l">Dismissed</span></div>
        <div className="stat"><span className="v">{byStatus.ACTED_ON ?? 0}</span><span className="l">Acted on</span></div>
      </div>

      <div className="lane-head">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {["PROPOSED", "SHORTLISTED", "DISMISSED", "ALL"].map((s) => (
            <a key={s} href={`/matchmake?status=${s}&sort=${sort}`} className={s === status ? "chip on" : "chip"}>
              {s.toLowerCase().replace(/_/g, " ")} ({s === "ALL" ? total : byStatus[s] ?? 0})
            </a>
          ))}
          <a href={`/matchmake?status=${status}&sort=novelty`} className={sort === "novelty" ? "chip on" : "chip"}>
            most unusual first
          </a>
          <a href={`/matchmake?status=${status}&sort=confidence`} className={sort === "confidence" ? "chip on" : "chip"}>
            most confident first
          </a>
        </div>
        {hasApiKey() && (
          <form action={findMatches.bind(null, business.id)}>
            <button type="submit">Find more matches</button>
          </form>
        )}
      </div>

      {matches.length === 0 ? (
        <div className="empty">
          <h3>Nothing proposed yet</h3>
          <p>
            The matchmaker samples across industries rather than taking the highest-scoring companies, so it
            sees the whole board instead of forty aircon firms.
          </p>
          {hasApiKey() ? (
            <form action={findMatches.bind(null, business.id)}>
              <button type="submit">Find matches</button>
            </form>
          ) : (
            <p className="muted">Add an <code>ANTHROPIC_API_KEY</code> to run the matchmaker.</p>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {matches.map((m) => {
            const aEmail = m.companyA.contacts.find((c) => c.email)?.email;
            const bEmail = m.companyB.contacts.find((c) => c.email)?.email;
            const grounded = (m.groundedOn as string[] | null) ?? [];
            const assumed = (m.assumptions as string[] | null) ?? [];
            return (
              <div key={m.id} className="panel">
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                  <div style={{ fontSize: "1.02rem" }}>
                    <strong>{m.companyA.name}</strong>
                    <span className="muted"> × </span>
                    <strong>{m.companyB.name}</strong>
                    <div className="muted" style={{ fontSize: "0.78rem" }}>
                      {m.companyA.industry ?? "?"} × {m.companyB.industry ?? "?"}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: "0.76rem" }} className="muted">
                    <div>unusual {pct(m.novelty)} · confidence {pct(m.confidence)}</div>
                    {m.estimatedCommission && (
                      <div>~${Number(m.estimatedCommission).toFixed(0)} to you</div>
                    )}
                  </div>
                </div>

                <p style={{ margin: "0.7rem 0", fontSize: "0.95rem" }}>{m.pitch}</p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                  <div style={{ padding: "0.6rem 0.8rem", background: "var(--alt, rgba(255,255,255,0.04))", borderRadius: 4 }}>
                    <div className="muted" style={{ fontSize: "0.7rem", marginBottom: "0.25rem" }}>
                      {m.companyA.name} gets
                    </div>
                    <div style={{ fontSize: "0.86rem" }}>{m.valueToA}</div>
                  </div>
                  <div style={{ padding: "0.6rem 0.8rem", background: "var(--alt, rgba(255,255,255,0.04))", borderRadius: 4 }}>
                    <div className="muted" style={{ fontSize: "0.7rem", marginBottom: "0.25rem" }}>
                      {m.companyB.name} gets
                    </div>
                    <div style={{ fontSize: "0.86rem" }}>{m.valueToB}</div>
                  </div>
                </div>

                {m.whyNow && (
                  <p style={{ margin: "0.7rem 0 0", fontSize: "0.85rem" }}>
                    <strong>Why now:</strong> {m.whyNow}
                  </p>
                )}

                <details style={{ marginTop: "0.6rem" }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: "0.8rem" }}>
                    What this rests on ({grounded.length} verified, {assumed.length} assumed)
                  </summary>
                  {grounded.length > 0 && (
                    <>
                      <div className="muted" style={{ fontSize: "0.74rem", marginTop: "0.5rem" }}>From the data:</div>
                      <ul style={{ fontSize: "0.82rem", margin: "0.2rem 0" }}>
                        {grounded.map((g) => <li key={g}>{g}</li>)}
                      </ul>
                    </>
                  )}
                  {assumed.length > 0 && (
                    <>
                      <div className="muted" style={{ fontSize: "0.74rem", marginTop: "0.5rem" }}>
                        Assumed, not verified — check before acting:
                      </div>
                      <ul style={{ fontSize: "0.82rem", margin: "0.2rem 0" }}>
                        {assumed.map((a) => <li key={a}>{a}</li>)}
                      </ul>
                    </>
                  )}
                  <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.4rem" }}>
                    {aEmail ?? "no email for A"} · {bEmail ?? "no email for B"}
                  </div>
                </details>

                <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
                  {(["SHORTLISTED", "ACTED_ON", "DISMISSED"] as const)
                    .filter((s) => s !== m.status)
                    .map((s) => (
                      <form key={s} action={setMatchStatus.bind(null, business.id)}>
                        <input type="hidden" name="id" value={m.id} />
                        <input type="hidden" name="status" value={s} />
                        <button type="submit" className="ghost" style={{ fontSize: "0.74rem" }}>
                          {s === "SHORTLISTED" ? "Shortlist" : s === "ACTED_ON" ? "Acted on" : "Dismiss"}
                        </button>
                      </form>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
