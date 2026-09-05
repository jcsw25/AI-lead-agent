import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { findMatches, setMatchStatus } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Pairings — two real companies, and the case for introducing them.
 *
 * Rebuilt from a page that gave every card identical weight and buried the one
 * thing a reader is deciding on. A pairing is a claim with two halves — "A gets
 * this, B gets that" — and if either half is weak the pair is not worth an
 * introduction. So the two halves ARE the card, set side by side and equally
 * sized, with everything else subordinate.
 *
 * Confidence and novelty used to print as bare percentages, which say nothing
 * alone. They are bars now: the comparison between cards is the useful part,
 * not the number.
 */

const pct = (n: number) => Math.round(n * 100);

export default async function PairingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string }>;
}) {
  const { status = "PROPOSED", sort = "novelty" } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const [matches, counts] = await Promise.all([
    db.matchmake.findMany({
      where: { businessId: business.id, ...(status === "ALL" ? {} : { status: status as never }) },
      orderBy: sort === "confidence" ? { confidence: "desc" } : { novelty: "desc" },
      take: 60,
      include: {
        companyA: { select: { name: true, industry: true, websiteUrl: true, contacts: { select: { email: true } } } },
        companyB: { select: { name: true, industry: true, websiteUrl: true, contacts: { select: { email: true } } } },
      },
    }),
    db.matchmake.groupBy({ by: ["status"], where: { businessId: business.id }, _count: { _all: true } }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  const total = counts.reduce((s, c) => s + c._count._all, 0);

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Pairings · both sides must gain</p>
        <h1>Pairings</h1>
        <p className="sub">
          Two real companies from the database, and the case for introducing them. Every pairing has to work in
          both directions — a one-sided one is a sales lead with better manners, where one party gains and the
          other pays. Each card states what each side gets separately, so a weak half shows at a glance.
        </p>
      </div>

      <div className="stats" style={{ marginBottom: "1.25rem" }}>
        <div className="stat"><span className="v">{byStatus.PROPOSED ?? 0}</span><span className="l">To review</span></div>
        <div className="stat good"><span className="v">{byStatus.SHORTLISTED ?? 0}</span><span className="l">Shortlisted</span></div>
        <div className="stat"><span className="v">{byStatus.ACTED_ON ?? 0}</span><span className="l">Acted on</span></div>
        <div className="stat"><span className="v">{byStatus.DISMISSED ?? 0}</span><span className="l">Dismissed</span></div>
      </div>

      <div className="lane-head">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {["PROPOSED", "SHORTLISTED", "ACTED_ON", "DISMISSED", "ALL"].map((s) => (
            <a key={s} href={`/pairings?status=${s}&sort=${sort}`} className={s === status ? "chip on" : "chip"}>
              {s === "ALL" ? "all" : s.toLowerCase().replace(/_/g, " ")} ({s === "ALL" ? total : byStatus[s] ?? 0})
            </a>
          ))}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          {/* Sorting used to sit inside the status filter row, so the two read
              as one line of unrelated toggles. Separated and labelled. */}
          <span className="muted" style={{ fontSize: "0.76rem" }}>sort</span>
          {[
            { k: "novelty", label: "most unusual" },
            { k: "confidence", label: "most confident" },
          ].map((o) => (
            <a key={o.k} href={`/pairings?status=${status}&sort=${o.k}`} className={sort === o.k ? "chip on" : "chip"}>
              {o.label}
            </a>
          ))}
          {hasApiKey() && (
            <form action={findMatches.bind(null, business.id)}>
              <button type="submit">Find more</button>
            </form>
          )}
        </div>
      </div>

      {matches.length === 0 ? (
        <div className="empty">
          <h3>Nothing at this status</h3>
          <p>
            The matchmaker samples across industries rather than taking the highest-scoring companies, so it sees
            the whole board instead of forty aircon firms.
          </p>
          {hasApiKey() ? (
            <form action={findMatches.bind(null, business.id)}>
              <button type="submit">Find pairings</button>
            </form>
          ) : (
            <p className="muted">Add an <code>ANTHROPIC_API_KEY</code> to run the matchmaker.</p>
          )}
        </div>
      ) : (
        <div className="pair-list">
          {matches.map((m) => {
            const aEmail = m.companyA.contacts.find((c) => c.email)?.email;
            const bEmail = m.companyB.contacts.find((c) => c.email)?.email;
            const grounded = (m.groundedOn as string[] | null) ?? [];
            const assumed = (m.assumptions as string[] | null) ?? [];
            const reachable = Boolean(aEmail) && Boolean(bEmail);

            return (
              <article key={m.id} className="pair">
                <header className="pair-top">
                  <h2 className="pair-who">
                    <span className="co">{m.companyA.name}</span>
                    <span className="join">×</span>
                    <span className="co">{m.companyB.name}</span>
                  </h2>
                  <div className="pair-meters">
                    <span className="meter">
                      <span className="ml">confidence</span>
                      <span className="track"><span className="fill" style={{ width: `${pct(m.confidence)}%` }} /></span>
                    </span>
                    <span className="meter">
                      <span className="ml">unusual</span>
                      <span className="track"><span className="fill alt" style={{ width: `${pct(m.novelty)}%` }} /></span>
                    </span>
                  </div>
                </header>

                <p className="pair-industries">
                  {m.companyA.industry ?? "industry not recorded"} · {m.companyB.industry ?? "industry not recorded"}
                  {m.estimatedCommission ? ` · about $${Number(m.estimatedCommission).toFixed(0)} to you` : ""}
                </p>

                <p className="pair-pitch">{m.pitch}</p>

                {/* The two halves, equally sized. If either is weak the pairing
                    is not worth an introduction, and that must be visible
                    without reading a paragraph to find it. */}
                <div className="pair-sides">
                  <div className="side">
                    <span className="sl">{m.companyA.name} gets</span>
                    <p>{m.valueToA}</p>
                  </div>
                  <div className="side">
                    <span className="sl">{m.companyB.name} gets</span>
                    <p>{m.valueToB}</p>
                  </div>
                </div>

                {m.whyNow && <p className="pair-why"><strong>Why now</strong> · {m.whyNow}</p>}

                <div className="pair-foot">
                  <details>
                    <summary>What this rests on — {grounded.length} verified, {assumed.length} assumed</summary>
                    {grounded.length > 0 && (
                      <>
                        <span className="dl">From the data</span>
                        <ul>{grounded.map((g) => <li key={g}>{g}</li>)}</ul>
                      </>
                    )}
                    {assumed.length > 0 && (
                      <>
                        <span className="dl">Assumed, not verified — check before acting</span>
                        <ul>{assumed.map((a) => <li key={a}>{a}</li>)}</ul>
                      </>
                    )}
                    <span className="dl">Contacts</span>
                    <ul>
                      <li>{m.companyA.name}: {aEmail ?? "no email found"}</li>
                      <li>{m.companyB.name}: {bEmail ?? "no email found"}</li>
                    </ul>
                  </details>

                  <div className="pair-actions">
                    {/* Whether both sides can actually be reached decides whether
                        this is actionable at all, so it sits with the buttons
                        rather than buried inside the details block. */}
                    <span className={reachable ? "tag good" : "tag muted"}>
                      {reachable
                        ? "both reachable"
                        : aEmail || bEmail
                          ? "only one side has an email"
                          : "neither side has an email"}
                    </span>
                    {(["SHORTLISTED", "ACTED_ON", "DISMISSED"] as const)
                      .filter((s) => s !== m.status)
                      .map((s) => (
                        <form key={s} action={setMatchStatus.bind(null, business.id)}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="status" value={s} />
                          <button type="submit" className={s === "SHORTLISTED" ? "" : "ghost"}>
                            {s === "SHORTLISTED" ? "Shortlist" : s === "ACTED_ON" ? "Acted on" : "Dismiss"}
                          </button>
                        </form>
                      ))}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
