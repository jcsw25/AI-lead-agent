import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { money } from "@/lib/pipeline";
import { hasApiKey } from "@/agents/runtime";
import { SUPPLIER_SECTORS } from "@/agents/pairing-scout";
import { autoDiscover, scoutSector, scrapeSuppliers, setPairingStatus, sweepSectors } from "./actions";

export const dynamic = "force-dynamic";

export default async function PairingsPage() {
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const pairings = await db.pairing.findMany({
    where: { businessId: business.id },
    include: { _count: { select: { leads: true } } },
    orderBy: [{ status: "asc" }, { score: "desc" }],
  });

  // Group by supplier side so a few hundred rows stay navigable.
  const bySupplier = new Map<string, typeof pairings>();
  for (const p of pairings) {
    const k = p.supplierIndustry;
    bySupplier.set(k, [...(bySupplier.get(k) ?? []), p]);
  }
  const groups = [...bySupplier.entries()].sort(
    (a, b) => Math.max(...b[1].map((x) => x.score)) - Math.max(...a[1].map((x) => x.score)),
  );
  const covered = new Set(pairings.map((p) => p.supplierIndustry.toLowerCase()));
  const uncovered = SUPPLIER_SECTORS.filter(
    (s) => ![...covered].some((c) => c.includes(s.toLowerCase().split(/[ ,]/)[0])),
  );

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">The pair database</p>
        <h1>Who has what, and who needs it</h1>
        <p className="sub">
          Each row is a reusable thesis: companies in one industry have something companies in another need, plus
          the trigger that makes them act. Recruit the supply side, sell the demand side, take the middle.
        </p>
      </div>

      <div className="stats" style={{ marginBottom: "1.25rem" }}>
        <div className="stat"><span className="v">{pairings.length}</span><span className="l">Pairings</span></div>
        <div className="stat"><span className="v">{groups.length}</span><span className="l">Supplier sectors</span></div>
        <div className="stat good"><span className="v">{pairings.filter((p) => p.status === "active").length}</span><span className="l">Active</span></div>
        <div className="stat"><span className="v">{pairings.reduce((s, p) => s + p._count.leads, 0)}</span><span className="l">Suppliers scraped</span></div>
      </div>

      <div className="card" style={{ marginBottom: "1.75rem" }}>
        <h2 style={{ marginTop: 0 }}>Generate more</h2>
        <p className="muted" style={{ marginTop: "-.4rem" }}>
          The scout works one supplier sector at a time — an open-ended &ldquo;suggest pairings&rdquo; prompt
          returns the same dozen obvious ones. It is held to a rule: the buyer must face a dated deadline
          (a licence, a lease, an audit, a season), not merely a preference.
        </p>
        {!hasApiKey() ? (
          <div className="banner" style={{ margin: 0 }}>
            <b>Needs an API key.</b>
            <span>Set <code>ANTHROPIC_API_KEY</code> in <code>.env</code> — generation is the one thing that cannot be simulated usefully.</span>
          </div>
        ) : (
          <>
            <div className="actions" style={{ marginBottom: ".75rem" }}>
              <form action={sweepSectors.bind(null, business.id)}>
                <button className="btn" type="submit">Sweep all {SUPPLIER_SECTORS.length} sectors (~{SUPPLIER_SECTORS.length * 8} pairings)</button>
              </form>
              <span className="muted">Several minutes and a real API bill. Runs sequentially.</span>
            </div>
            {uncovered.length > 0 && (
              <>
                <p className="muted" style={{ margin: ".5rem 0 .4rem" }}>Or one sector at a time — not yet covered:</p>
                <div className="actions">
                  {uncovered.slice(0, 12).map((sec) => (
                    <form key={sec} action={scoutSector.bind(null, business.id, sec)}>
                      <button className="btn ghost" type="submit">{sec.split(/[ ,]/).slice(0, 3).join(" ")}</button>
                    </form>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {pairings.length === 0 ? (
        <div className="empty">
          <h3>No pairings yet</h3>
          <p>Seed the starting set: <code>npm run db:seed:pairings</code></p>
        </div>
      ) : (
        groups.map(([sector, rows]) => (
        <section key={sector}>
          <div className="lane-head">
            <h2>{sector}</h2>
            <span className="muted">{rows.length} buyer{rows.length === 1 ? "" : "s"}</span>
          </div>
        <div className="grid">
          {rows.map((p) => (
            <article key={p.id} className="card play">
              <div className="play-top">
                <div>
                  <h3><span className="muted">→</span> {p.buyerIndustry}</h3>
                  <span className="motion">
                    <span className={`lane lane-${p.lane}`}>{p.lane}</span>
                    {" "}{p._count.leads} supplier{p._count.leads === 1 ? "" : "s"} scraped · {p.status}
                  </span>
                </div>
                <span className="score-chip">{Math.round(p.score * 100)}</span>
              </div>

              <dl>
                <dt>What A has</dt>
                <dd>{p.whatAHas}</dd>
                <dt>What B needs</dt>
                <dd className="why">{p.whatBNeeds}</dd>
                <dt>Why now</dt>
                <dd>{p.trigger}</dd>
                {p.timingWindow && (<><dt>Reach out</dt><dd>{p.timingWindow}</dd></>)}
                <dt>Reach A / Reach B</dt>
                <dd>{p.reachA.join(" · ")} <span className="muted">/</span> {p.reachB.join(" · ")}</dd>
                <dt>Deal size · our cut</dt>
                <dd className="mono">
                  {money(p.typicalDealLow, p.currency)}–{money(p.typicalDealHigh, p.currency)}
                  {p.commissionRate ? ` · ${Number(p.commissionRate)}%` : ""}
                </dd>
              </dl>

              <div className="actions">
                <form action={autoDiscover.bind(null, business.id, p.id, "A")}>
                  <button className="btn" type="submit">Find suppliers (A)</button>
                </form>
                <form action={autoDiscover.bind(null, business.id, p.id, "B")}>
                  <button className="btn ghost" type="submit">Find buyers (B)</button>
                </form>
                <span className="muted">
                  Searches OpenStreetMap{hasApiKey() ? " and the web" : ""}, then crawls whatever has a site.
                </span>
              </div>

              <details>
                <summary style={{ cursor: "pointer", fontSize: ".9rem", color: "var(--accent)" }}>
                  Or paste domains manually
                </summary>
                <form action={scrapeSuppliers.bind(null, business.id, p.id)} className="callform">
                  <label>
                    Supplier websites <span className="muted">— one per line, up to 40</span>
                    <textarea name="domains" rows={4} placeholder={"greencoolaircon.com\nsingaporeaircond.com\nexample.com.sg"} />
                  </label>
                  <button className="btn" type="submit">Scrape and add to database</button>
                  <span className="muted">
                    Respects robots.txt, one request per site at a time. Roughly 15–25 seconds per company.
                  </span>
                </form>
              </details>

              <div className="actions">
                <form action={setPairingStatus.bind(null, p.id, p.status === "active" ? "parked" : "active")}>
                  <button className="btn ghost" type="submit">
                    {p.status === "active" ? "Park" : "Mark active"}
                  </button>
                </form>
              </div>
            </article>
          ))}
        </div>
        </section>
        ))
      )}
    </>
  );
}
