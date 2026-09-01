import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { draftBuyerEmail, generatePairings, rematch, setIntroductionStatus } from "./actions";

export const dynamic = "force-dynamic";

const NEXT_STATUS: Record<string, { to: string; label: string }[]> = {
  PROPOSED: [{ to: "APPROVED", label: "Approve" }, { to: "DISCARDED", label: "Discard" }],
  APPROVED: [{ to: "A_CONTACTED", label: "Contacted A" }, { to: "DISCARDED", label: "Discard" }],
  // "A agreed" onboards them as a real Supplier — see introductions/actions.ts.
  A_CONTACTED: [{ to: "A_AGREED", label: "A agreed — onboard them" }, { to: "LOST", label: "A declined" }],
  A_AGREED: [],
  B_CONTACTED: [{ to: "INTRODUCED", label: "Introduced" }, { to: "LOST", label: "B declined" }],
  INTRODUCED: [{ to: "WON", label: "Closed" }, { to: "LOST", label: "Lost" }],
};

export default async function IntroductionsPage({
  searchParams,
}: {
  searchParams: Promise<{ pairing?: string; status?: string }>;
}) {
  const { pairing: pairingId, status } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const where = {
    businessId: business.id,
    ...(pairingId ? { pairingId } : {}),
    ...(status ? { status: status as never } : {}),
  };

  const [intros, total, pairings, statusCounts] = await Promise.all([
    db.introduction.findMany({
      where,
      orderBy: [{ fitScore: "desc" }],
      take: 100,
      include: {
        pairing: { select: { id: true, supplierIndustry: true, buyerIndustry: true, lane: true, whatAHas: true, whatBNeeds: true } },
        companyA: { select: { name: true, primaryDomain: true, websiteUrl: true, contacts: { select: { email: true, phone: true } } } },
        companyB: { select: { name: true, primaryDomain: true, websiteUrl: true, contacts: { select: { email: true, phone: true } } } },
      },
    }),
    db.introduction.count({ where: { businessId: business.id } }),
    db.introduction.groupBy({
      by: ["pairingId"], where: { businessId: business.id },
      _count: { _all: true }, _max: { fitScore: true },
    }),
    db.introduction.groupBy({
      by: ["status"], where: { businessId: business.id }, _count: { _all: true },
    }),
  ]);

  const pairingMeta = await db.pairing.findMany({
    where: { id: { in: pairings.map((p) => p.pairingId) } },
    select: { id: true, supplierIndustry: true, buyerIndustry: true, score: true },
  });
  const metaById = new Map(pairingMeta.map((p) => [p.id, p]));

  const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));
  const ceiling = (
    await db.introduction.findMany({ where: { businessId: business.id }, select: { estimatedCommission: true } })
  ).reduce((s, i) => s + Number(i.estimatedCommission ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">The business model</p>
        <h1>Introductions</h1>
        <p className="sub">
          Two specific companies who should meet, and why. Side A has the capability, side B has the need, and
          you take a percentage of what closes. Fit is computed by arithmetic over observable features — expand
          any row to see exactly which ones.
        </p>
      </div>

      {total === 0 ? (
        <div className="empty">
          <h3>No introductions yet</h3>
          <p>
            Introductions come from pairings — an A→B thesis keyed to industries actually in the database.
            Generate them, and the company-level matches follow automatically.
          </p>
          {hasApiKey() ? (
            <form action={generatePairings.bind(null, business.id)}>
              <button type="submit">Generate pairings and match</button>
            </form>
          ) : (
            <p className="muted">Add an <code>ANTHROPIC_API_KEY</code> to generate theses.</p>
          )}
        </div>
      ) : (
        <>
          <div className="stats" style={{ marginBottom: "1.25rem" }}>
            <div className="stat"><span className="v">{total}</span><span className="l">Introductions</span></div>
            <div className="stat good"><span className="v">{byStatus.APPROVED ?? 0}</span><span className="l">Approved</span></div>
            <div className="stat"><span className="v">{pairings.length}</span><span className="l">Live pairings</span></div>
            <div className="stat">
              <span className="v">${Math.round(ceiling / 1000)}k</span>
              <span className="l">Commission ceiling</span>
            </div>
          </div>

          <p className="muted" style={{ fontSize: "0.84rem", marginTop: "-0.75rem" }}>
            The ceiling assumes every introduction closes at the pairing&rsquo;s midpoint deal size. Nothing has
            been contacted, so treat it as the size of the board, not a forecast.
          </p>

          <div className="lane-head" style={{ marginTop: "1.5rem" }}>
            <h2>By pairing</h2>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <form action={rematch.bind(null, business.id)}>
                <button type="submit" className="ghost">Recompute matches</button>
              </form>
              {hasApiKey() && (
                <form action={generatePairings.bind(null, business.id)}>
                  <button type="submit" className="ghost">Find more pairings</button>
                </form>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "1rem" }}>
            <a href="/introductions" className={pairingId ? "chip" : "chip on"}>all</a>
            {pairings
              .sort((a, b) => (b._max.fitScore ?? 0) - (a._max.fitScore ?? 0))
              .map((p) => {
                const m = metaById.get(p.pairingId);
                if (!m) return null;
                return (
                  <a key={p.pairingId} href={`/introductions?pairing=${p.pairingId}`}
                     className={pairingId === p.pairingId ? "chip on" : "chip"}>
                    {m.supplierIndustry} → {m.buyerIndustry} ({p._count._all})
                  </a>
                );
              })}
          </div>

          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Fit</th><th>Side A — has it</th><th>Side B — needs it</th>
                  <th>Commission</th><th>Why now</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {intros.map((i) => {
                  const aEmail = i.companyA.contacts.find((c) => c.email)?.email;
                  const bEmail = i.companyB.contacts.find((c) => c.email)?.email;
                  const aPhone = i.companyA.contacts.find((c) => c.phone)?.phone;
                  const bPhone = i.companyB.contacts.find((c) => c.phone)?.phone;
                  const factors = (i.factors as Array<{ factor: string; rawValue: number; weight: number; contribution: number; evidence: string }>) ?? [];
                  return (
                    <tr key={i.id}>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>
                        <strong>{i.fitScore.toFixed(2)}</strong>
                      </td>
                      <td>
                        <strong>{i.companyA.name}</strong>
                        <div className="muted" style={{ fontSize: "0.76rem" }}>
                          {i.pairing.supplierIndustry}
                          {aEmail ? <div>{aEmail}</div> : aPhone ? <div>{aPhone}</div> : <div>no route</div>}
                        </div>
                      </td>
                      <td>
                        <strong>{i.companyB.name}</strong>
                        <div className="muted" style={{ fontSize: "0.76rem" }}>
                          {i.pairing.buyerIndustry}
                          {bEmail ? <div>{bEmail}</div> : bPhone ? <div>{bPhone}</div> : <div>no route</div>}
                        </div>
                      </td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>
                        {i.estimatedCommission ? `$${Number(i.estimatedCommission).toFixed(0)}` : "—"}
                        <div className="muted" style={{ fontSize: "0.72rem" }}>
                          {i.estimatedDealValue ? `of $${Number(i.estimatedDealValue).toFixed(0)}` : ""}
                        </div>
                      </td>
                      <td style={{ maxWidth: "26rem" }}>
                        <details>
                          <summary style={{ cursor: "pointer", fontSize: "0.82rem" }}>
                            {(i.trigger ?? i.rationale).slice(0, 80)}…
                          </summary>
                          <p style={{ fontSize: "0.82rem" }}>{i.rationale}</p>
                          {i.trigger && (
                            <p style={{ fontSize: "0.82rem" }}><strong>Why now:</strong> {i.trigger}</p>
                          )}
                          <table style={{ fontSize: "0.74rem" }}>
                            <tbody>
                              {factors.map((f) => (
                                <tr key={f.factor}>
                                  <td>{f.factor}</td>
                                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{f.rawValue}</td>
                                  <td className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>×{f.weight}</td>
                                  <td className="muted">{f.evidence}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </details>
                      </td>
                      <td>
                        <div className="muted" style={{ fontSize: "0.74rem", marginBottom: "0.3rem" }}>
                          {i.status.toLowerCase().replace(/_/g, " ")}
                        </div>
                        <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                          {i.status === "A_AGREED" && (
                            <form action={draftBuyerEmail.bind(null, business.id)}>
                              <input type="hidden" name="companyAId" value={i.companyAId} />
                              <input type="hidden" name="limit" value="3" />
                              <button type="submit" style={{ fontSize: "0.72rem" }}>Write to buyer</button>
                            </form>
                          )}
                          {(NEXT_STATUS[i.status] ?? []).map((n) => (
                            <form key={n.to} action={setIntroductionStatus.bind(null, business.id)}>
                              <input type="hidden" name="id" value={i.id} />
                              <input type="hidden" name="status" value={n.to} />
                              <button type="submit" className="ghost" style={{ fontSize: "0.72rem" }}>{n.label}</button>
                            </form>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
