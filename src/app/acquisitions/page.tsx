import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { targetCounts, targetQueue } from "@/lib/acquisition/targets";
import { MARKETPLACES } from "@/lib/acquisition/marketplaces";
import { collectListings, draftApproaches, seedProprietary, setStatus } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_COPY: Record<string, { label: string; meaning: string; tone: string }> = {
  IDENTIFIED: {
    label: "found",
    meaning: "Found and nobody has been contacted. A listed business advertised itself; a proprietary one has told nobody anything.",
    tone: "lane-ADJACENT",
  },
  APPROACHED: { label: "asked", meaning: "The approach went out. No answer yet.", tone: "lane-SEASONAL" },
  INTERESTED: {
    label: "interested",
    meaning: "They wrote back and said they would consider it. This status is only ever set from a reply.",
    tone: "lane-TRIGGER",
  },
  NDA_SIGNED: { label: "NDA signed", meaning: "An NDA is executed both ways. Specifics can be discussed.", tone: "lane-TRIGGER" },
  FINANCIALS: { label: "financials in", meaning: "They sent numbers. Now the business can actually be judged.", tone: "lane-TRIGGER" },
  LOI: { label: "LOI", meaning: "A letter of intent is on the table.", tone: "lane-TRIGGER" },
  DEAD: { label: "dead", meaning: "Not selling, or we passed.", tone: "lane-CONTRARIAN" },
};

const ORDER = ["IDENTIFIED", "APPROACHED", "INTERESTED", "NDA_SIGNED", "FINANCIALS", "LOI", "DEAD"];

function money(v: unknown, currency: string): string {
  if (v == null) return "—";
  const n = Number(v);
  if (n >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`;
  if (n >= 1000) return `${currency} ${Math.round(n / 1000)}k`;
  return `${currency} ${n.toLocaleString()}`;
}

export default async function AcquisitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; origin?: string }>;
}) {
  const { status = "IDENTIFIED", origin } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const [targets, counts, byOrigin, withPrice] = await Promise.all([
    targetQueue(business.id, {
      status: status as never,
      origin: origin === "LISTED" || origin === "PROPRIETARY" ? origin : undefined,
      limit: 80,
    }),
    targetCounts(business.id),
    db.acquisitionTarget.groupBy({ by: ["origin"], where: { businessId: business.id }, _count: { _all: true } }),
    db.acquisitionTarget.findMany({
      where: { businessId: business.id, askingPrice: { not: null } },
      select: { askingPrice: true, askingMultiple: true },
    }),
  ]);

  // What listings actually call their profit figure. This turned out to be the
  // most useful single number on the page: of 91 collected, exactly one
  // published EBITDA. Twenty quote a MONTHLY profit. Nothing here is comparable
  // to anything else until the financials arrive.
  const profitTerms = await db.acquisitionTarget.groupBy({
    by: ["profitTerm"],
    where: { businessId: business.id, profitTerm: { not: null } },
    _count: { _all: true },
  });
  const termTotal = profitTerms.reduce((a, t) => a + t._count._all, 0);
  const ebitdaCount = profitTerms
    .filter((t) => /\bebitda\b/i.test(t.profitTerm ?? ""))
    .reduce((a, t) => a + t._count._all, 0);

  const originCounts = Object.fromEntries(byOrigin.map((o) => [o.origin, o._count._all]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Median rather than mean: one 20m listing drags an average somewhere no
  // actual business sits.
  const prices = withPrice.map((t) => Number(t.askingPrice)).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const multiples = withPrice.map((t) => t.askingMultiple).filter((m): m is number => m != null);

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Acquisition · buy the business, not the contract</p>
        <h1>Acquisitions</h1>
        <p className="sub">
          Companies worth buying, in two lanes. <strong>Listed</strong> businesses advertised themselves on a
          marketplace — everyone can see them, so the competition is the listing. <strong>Proprietary</strong> ones
          have told nobody anything: no broker, no competing bidder, and an owner who has not yet decided what the
          business is worth. Most will say no, so the ask is small enough that a no costs nothing.
        </p>
      </div>

      <div className="stats" style={{ marginBottom: "1.25rem" }}>
        <div className="stat"><span className="v">{originCounts.LISTED ?? 0}</span><span className="l">Advertised for sale</span></div>
        <div className="stat"><span className="v">{originCounts.PROPRIETARY ?? 0}</span><span className="l">Not on the market</span></div>
        <div className="stat"><span className="v">{counts.APPROACHED ?? 0}</span><span className="l">Asked</span></div>
        <div className="stat good"><span className="v">{counts.INTERESTED ?? 0}</span><span className="l">Would consider it</span></div>
      </div>

      <p className="muted" style={{ fontSize: "0.84rem", marginTop: "-0.75rem" }}>
        {median
          ? `Median advertised asking price ${money(median, "SGD")} across ${prices.length} listings that publish one. `
          : "No advertised prices collected yet. "}
        {termTotal > 0
          ? `${termTotal} publish a profit figure — but only ${ebitdaCount} of them call it EBITDA, so ${multiples.length} multiple${multiples.length === 1 ? "" : "s"} can honestly be computed.`
          : "None publish a profit figure yet."}
      </p>

      <div className="notice" style={{ marginTop: "1rem" }}>
        <strong>Nothing here estimates what a business is worth.</strong> Every figure shown is one the listing
        itself published, and a multiple is only computed where the listing&rsquo;s own profit figure is EBITDA.
        {termTotal > 0 && (
          <>
            {" "}
            That is rarer than it sounds — of {termTotal} listings that publish a profit figure, these are the terms
            they use:{" "}
            {profitTerms
              .sort((a, b) => b._count._all - a._count._all)
              .map((t) => `${t.profitTerm} (${t._count._all})`)
              .join(", ")}
            . A monthly profit against an annual asking price produces a multiple roughly twelve times too high,
            and SDE includes the owner&rsquo;s own salary. They are not the same number, so they are not converted
            into one.
          </>
        )}
      </div>

      <div className="panel" style={{ marginTop: "1.25rem" }}>
        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <form action={collectListings.bind(null, business.id)} style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
            <div>
              <label className="muted" style={{ display: "block", fontSize: "0.76rem" }}>
                Read the {MARKETPLACES.length} marketplaces
              </label>
              <input name="industry" placeholder="any industry (optional)" style={{ width: "14rem" }} />
            </div>
            <button type="submit">Collect listings</button>
          </form>

          <form action={seedProprietary.bind(null, business.id)} style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
            <div>
              <label className="muted" style={{ display: "block", fontSize: "0.76rem" }}>
                Target companies you already hold
              </label>
              <input name="industry" placeholder="e.g. aircon servicing" required style={{ width: "14rem" }} />
            </div>
            <button type="submit" className="ghost">Add proprietary targets</button>
          </form>

          {hasApiKey() && (
            <form action={draftApproaches.bind(null, business.id)} style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
              <input type="hidden" name="origin" value={origin ?? ""} />
              <button type="submit" className="ghost">Draft 5 approaches</button>
            </form>
          )}
        </div>
        <p className="muted" style={{ fontSize: "0.78rem", margin: "0.7rem 0 0" }}>
          Drafts land in <a href="/approvals">Approvals</a> and pass the same compliance gate as everything else —
          an acquisition enquiry is still unsolicited commercial email under the Spam Control Act.
        </p>
      </div>

      <div className="lane-head" style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {ORDER.map((s) => (
            <a
              key={s}
              href={`/acquisitions?status=${s}${origin ? `&origin=${origin}` : ""}`}
              className={s === status ? "chip on" : "chip"}
            >
              {STATUS_COPY[s].label} ({counts[s] ?? 0})
            </a>
          ))}
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {[
            { k: "", label: "both lanes" },
            { k: "LISTED", label: "listed" },
            { k: "PROPRIETARY", label: "proprietary" },
          ].map((o) => (
            <a
              key={o.k}
              href={`/acquisitions?status=${status}${o.k ? `&origin=${o.k}` : ""}`}
              className={(origin ?? "") === o.k ? "chip on" : "chip"}
            >
              {o.label}
            </a>
          ))}
        </div>
      </div>

      <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 1rem" }}>
        {STATUS_COPY[status]?.meaning}
      </p>

      {total === 0 ? (
        <div className="empty">
          <h3>No targets yet</h3>
          <p>
            Read the marketplaces for what is advertised, or turn companies you already hold into targets nobody
            else is approaching.
          </p>
        </div>
      ) : targets.length === 0 ? (
        <div className="empty"><h3>Nothing at this status</h3></div>
      ) : (
        <div style={{ display: "grid", gap: "0.9rem" }}>
          {targets.map((t) => {
            const email = t.company?.contacts[0]?.email;
            return (
              <div key={t.id} className="panel">
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                  <div style={{ minWidth: "18rem", flex: 1 }}>
                    <strong>{t.name}</strong>
                    <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.15rem" }}>
                      <span className={`lane ${t.origin === "LISTED" ? "lane-SEASONAL" : "lane-TRIGGER"}`}>
                        {t.origin === "LISTED" ? "advertised" : "not on the market"}
                      </span>{" "}
                      {t.industry ?? "industry not stated"}
                      {t.listingSource ? ` · ${t.listingSource}` : ""}
                      {t.yearsEstablished ? ` · est. ${t.yearsEstablished}` : ""}
                      {t.employeeCount ? ` · ${t.employeeCount} staff` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: "0.82rem", fontVariantNumeric: "tabular-nums" }}>
                    <div><strong>{money(t.askingPrice, t.currency)}</strong> asking</div>
                    <div className="muted">
                      revenue {money(t.revenue, t.currency)} ·{" "}
                      {/* The term is shown beside the number, never hidden behind it —
                          "profit 20,000" reads as annual, and on twenty of these it is
                          a monthly figure. */}
                      {t.profitTerm ? t.profitTerm.toLowerCase() : "profit"} {money(t.ebitda, t.currency)}
                      {t.askingMultiple ? ` · ${t.askingMultiple}x EBITDA` : ""}
                    </div>
                  </div>
                </div>

                {t.listingSummary && (
                  <p style={{ fontSize: "0.86rem", margin: "0.6rem 0 0" }}>{t.listingSummary}</p>
                )}

                {t.sellerReason && (
                  <p className="muted" style={{ fontSize: "0.8rem", margin: "0.45rem 0 0" }}>
                    Selling because: {t.sellerReason}
                  </p>
                )}

                {t.verbatim && (
                  <blockquote
                    style={{
                      margin: "0.6rem 0 0",
                      padding: "0.4rem 0 0.4rem 0.9rem",
                      borderLeft: "3px solid var(--accent, #7aa2f7)",
                      fontStyle: "italic",
                      fontSize: "0.88rem",
                    }}
                  >
                    &ldquo;{t.verbatim}&rdquo;
                  </blockquote>
                )}

                {t.notes && (
                  <p className="muted" style={{ fontSize: "0.78rem", margin: "0.45rem 0 0" }}>{t.notes}</p>
                )}

                <div
                  style={{ display: "flex", gap: "0.5rem", marginTop: "0.7rem", flexWrap: "wrap", alignItems: "center" }}
                >
                  {t.listingUrl && (
                    <a href={t.listingUrl} target="_blank" rel="noopener noreferrer" className="chip">
                      the listing
                    </a>
                  )}
                  {t.websiteUrl && (
                    <a href={t.websiteUrl} target="_blank" rel="noopener noreferrer" className="chip">
                      their site
                    </a>
                  )}
                  {email && <span className="muted" style={{ fontSize: "0.78rem" }}>{email}</span>}
                  {!email && t.origin === "LISTED" && (
                    <span className="muted" style={{ fontSize: "0.78rem" }}>
                      anonymised — enquire through {t.listingSource} by hand
                    </span>
                  )}

                  <span style={{ flex: 1 }} />

                  {["NDA_SIGNED", "FINANCIALS", "LOI", "DEAD"]
                    .filter((s) => s !== t.status)
                    .map((s) => (
                      <form key={s} action={setStatus.bind(null, business.id)}>
                        <input type="hidden" name="id" value={t.id} />
                        <input type="hidden" name="status" value={s} />
                        <button type="submit" className="ghost" style={{ fontSize: "0.76rem", padding: "0.2rem 0.5rem" }}>
                          {STATUS_COPY[s].label}
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
