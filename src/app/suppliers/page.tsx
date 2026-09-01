import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { money } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const suppliers = await db.supplier.findMany({
    where: { businessId: business.id },
    include: { products: { where: { isActive: true } }, _count: { select: { products: true } } },
    orderBy: [{ isSelf: "desc" }, { name: "asc" }],
  });

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Supply side</p>
        <h1>What we can sell</h1>
        <p className="sub">
          Your own catalogue and the partners you broker for. The matchmaker treats them identically — only the
          commission terms differ, which is what makes &ldquo;sell my product&rdquo; and &ldquo;introduce two
          businesses for a cut&rdquo; the same machinery.
        </p>
      </div>

      {suppliers.map((s) => (
        <section key={s.id}>
          <div className="lane-head">
            <h2>{s.name}</h2>
            <span className={`lane ${s.isSelf ? "lane-DIRECT" : "lane-CHANNEL"}`}>
              {s.isSelf ? "OWN" : "PARTNER"}
            </span>
            <span className="muted">
              {s.isSelf
                ? "Full revenue"
                : `${s.defaultCommissionRate ? Number(s.defaultCommissionRate) + "%" : "—"} ${s.defaultCommissionModel.toLowerCase()} commission`}
              {s.contactEmail ? ` · ${s.contactEmail}` : ""}
            </span>
          </div>
          <div className="grid two">
            {s.products.map((p) => (
              <article key={p.id} className="card play">
                <div className="play-top">
                  <div>
                    <h3>{p.name}</h3>
                    <span className="motion">
                      {money(p.priceMin, p.currency)}–{money(p.priceMax, p.currency)}
                      {p.unit ? ` ${p.unit}` : ""}
                      {p.minOrderQty ? ` · min ${p.minOrderQty}` : ""}
                    </span>
                  </div>
                </div>
                <p>{p.description}</p>
                <dl>
                  <dt>Suits</dt>
                  <dd>{p.idealFor.join(" · ") || "unspecified"}</dd>
                </dl>
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
