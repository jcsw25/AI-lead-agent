import Link from "next/link";
import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { COLUMNS, columnFor, money } from "@/lib/pipeline";
import { hasApiKey } from "@/agents/runtime";
import { findCompanies, matchAllForPlay } from "./actions";

export const dynamic = "force-dynamic";

export default async function ProspectsPage() {
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const prospects = await db.prospect.findMany({
    where: { businessId: business.id },
    include: {
      company: true,
      play: true,
      contacts: { include: { contact: true }, orderBy: { isPrimary: "desc" }, take: 1 },
      matches: { include: { product: { include: { supplier: true } } }, orderBy: { fitScore: "desc" }, take: 1 },
    },
    orderBy: [{ lastActivityAt: "desc" }, { createdAt: "desc" }],
  });

  const plays = await db.industryPlay.findMany({
    where: { businessId: business.id, status: "accepted" },
    include: { _count: { select: { prospects: true } } },
    orderBy: { score: "desc" },
  });

  const grouped = COLUMNS.map((c) => ({ ...c, items: prospects.filter((p) => columnFor(p) === c.key) }));
  const unmatched = prospects.filter((p) => p.matches.length === 0).length;
  const pipelineValue = prospects.reduce((s, p) => s + Number(p.matches[0]?.estimatedDealValue ?? 0), 0);
  const commission = prospects.reduce((s, p) => s + Number(p.matches[0]?.estimatedCommission ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Pipeline</p>
        <h1>Prospects</h1>
        <p className="sub">
          Every company found under an industry play, the product matched to it, and where the conversation stands.
        </p>
      </div>

      {!hasApiKey() && (
        <div className="banner">
          <b>Simulated mode.</b>
          <span>
            Companies, contacts and drafts are samples. Contact addresses use the reserved <code>.test</code> domain,
            so nothing can reach a real inbox.
          </span>
        </div>
      )}

      <div className="stats" style={{ marginBottom: "1.5rem" }}>
        <div className="stat"><span className="v">{prospects.length}</span><span className="l">Prospects</span></div>
        <div className="stat hot"><span className="v">{grouped.find((g) => g.key === "HOT")?.items.length ?? 0}</span><span className="l">Hot</span></div>
        <div className="stat"><span className="v">{grouped.find((g) => g.key === "WARM")?.items.length ?? 0}</span><span className="l">Warm</span></div>
        <div className="stat"><span className="v" style={{ fontSize: "1.15rem" }}>{money(pipelineValue) ?? "—"}</span><span className="l">Pipeline value</span></div>
        <div className="stat good"><span className="v" style={{ fontSize: "1.15rem" }}>{money(commission) ?? "—"}</span><span className="l">Est. commission</span></div>
      </div>

      {plays.length === 0 ? (
        <div className="empty">
          <h3>No industries accepted yet</h3>
          <p>Accept an industry play first — discovery runs against it, so the hunter knows what to look for and why.</p>
          <Link className="btn" href="/industries">Go to Industries</Link>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: "1.75rem" }}>
          <h2 style={{ marginTop: 0 }}>Accepted industries</h2>
          <div className="grid">
            {plays.map((p) => (
              <div key={p.id} className="row">
                <div>
                  <b>{p.industry}</b> <span className={`lane lane-${p.lane}`}>{p.lane}</span>
                  <div className="muted">
                    {p._count.prospects} companies found · {p.timingWindow ?? "no window set"}
                  </div>
                </div>
                <div className="actions">
                  <form action={findCompanies.bind(null, business.id, p.id)}>
                    <button className="btn ghost" type="submit">Find companies</button>
                  </form>
                  {p._count.prospects > 0 && unmatched > 0 && (
                    <form action={matchAllForPlay.bind(null, business.id, p.id)}>
                      <button className="btn ghost" type="submit">Match products</button>
                    </form>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {prospects.length === 0 ? (
        <div className="empty">
          <h3>No companies yet</h3>
          <p>Use <b>Find companies</b> above to run discovery against an accepted industry.</p>
        </div>
      ) : (
        grouped.map((col) =>
          col.items.length === 0 ? null : (
            <section key={col.key}>
              <div className="lane-head">
                <h2>{col.label}</h2>
                <span className="muted">{col.items.length}</span>
              </div>
              <p className="muted" style={{ margin: "0 0 .9rem" }}>{col.hint}</p>
              <div className="grid">
                {col.items.map((p) => {
                  const m = p.matches[0];
                  const c = p.contacts[0]?.contact;
                  return (
                    <Link key={p.id} href={`/prospects/${p.id}`} className="card play rowlink">
                      <div className="play-top">
                        <div>
                          <h3>{p.company.name}</h3>
                          <span className="motion">
                            {p.company.industry ?? "—"}
                            {p.company.employeeBand ? ` · ${p.company.employeeBand}` : ""}
                            {c ? ` · ${c.fullName}, ${c.jobTitle}` : " · no contact yet"}
                          </span>
                        </div>
                        {p.tier && <span className={`lane lane-${p.tier === "HOT" ? "CONTRARIAN" : "SEASONAL"}`}>{p.tier}</span>}
                      </div>
                      {m ? (
                        <p className="muted" style={{ margin: 0 }}>
                          <b>{m.product.name}</b> — {m.product.supplier.isSelf ? "own product" : `via ${m.product.supplier.name}`}
                          {m.estimatedDealValue ? ` · ${money(m.estimatedDealValue, m.currency)} deal` : ""}
                          {m.estimatedCommission ? ` · ${money(m.estimatedCommission, m.currency)} commission` : ""}
                        </p>
                      ) : (
                        <p className="muted" style={{ margin: 0 }}>No product matched yet</p>
                      )}
                    </Link>
                  );
                })}
              </div>
            </section>
          ),
        )
      )}
    </>
  );
}
