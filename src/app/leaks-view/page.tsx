import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { pitchPriority } from "@/lib/scoring/pitch-priority";
import { pitchCoverage } from "@/lib/scoring/coverage";
import LeakCard from "./LeakCard";

export const dynamic = "force-dynamic";

/**
 * Who is losing the traffic they have.
 *
 * Rebuilt from a wide table that had three problems. Every row carried four
 * bullet points of prose in a table cell, and because most sites fail the same
 * checks, the same two sentences repeated down the entire page. The three
 * numbers sat as bare digits, and two of them were identical whenever reach hit
 * 100, so one looked redundant. And the findings shown were the RAW ones —
 * "nothing that asks for the booking near the top of the page" — which is the
 * verdict phrasing now banned from emails, so the screen and the draft
 * disagreed about what to say.
 *
 * It is a work queue, not a report. One company per card, the pitch score as
 * the headline, and the single line you would actually open with, quoted as it
 * would be said.
 */

export default async function LeaksPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string; min?: string }>;
}) {
  const { industry, min } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const minReach = Number(min ?? 1);

  const [targets, coverage, industries] = await Promise.all([
    pitchPriority({ industry, limit: 120, minReach }),
    pitchCoverage(industry),
    db.company.groupBy({
      by: ["industry"],
      where: { serpBestPosition: { not: null } },
      _count: { _all: true },
    }),
  ]);

  // Pinned first — a decision made on this page should be visible on this page,
  // not scrolled away by the ranking that produced it.
  const worth = targets
    .filter((t) => t.priority > 0)
    .sort((a, b) => {
      const pa = (a.pinnedForCall ? 1 : 0) + (a.pinnedForEmail ? 1 : 0);
      const pb = (b.pinnedForCall ? 1 : 0) + (b.pinnedForEmail ? 1 : 0);
      return pb - pa || b.priority - a.priority;
    });

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Targeting · traffic they are losing</p>
        <h1>Leaks</h1>
        <p className="sub">
          Companies people actually reach, whose website loses them anyway. Reach and leak multiply rather than
          add — only both together is money walking away every day.
        </p>
      </div>

      <div className="stats" style={{ marginBottom: "1rem" }}>
        <div className="stat good"><span className="v">{worth.length}</span><span className="l">Worth pitching</span></div>
        <div className="stat"><span className="v">{coverage.withReach}</span><span className="l">Have a search position</span></div>
        <div className="stat"><span className="v">{coverage.clean}</span><span className="l">Checked, nothing wrong</span></div>
        <div className="stat"><span className="v">{coverage.unassertable}</span><span className="l">Cannot be assessed</span></div>
      </div>

      <p className="muted" style={{ fontSize: "0.82rem", marginTop: "-0.5rem" }}>
        Of {coverage.total} companies{industry ? ` in ${industry}` : ""}, {coverage.withReach} have a search
        position — <code>npm run serp</code> fills the rest. {coverage.unassertable} render in the browser, where a
        missing button cannot be proven absent, so they score zero leaks rather than a clean bill of health and
        never appear here.
      </p>

      <div className="lane-head" style={{ marginTop: "1.5rem" }}>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <a href="/leaks-view" className={!industry ? "chip on" : "chip"}>every trade</a>
          {industries
            .sort((a, b) => b._count._all - a._count._all)
            .slice(0, 7)
            .map((i) => (
              <a
                key={i.industry}
                href={`/leaks-view?industry=${encodeURIComponent(i.industry!)}`}
                className={industry === i.industry ? "chip on" : "chip"}
              >
                {i.industry}
              </a>
            ))}
        </div>
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          <span className="muted" style={{ fontSize: "0.76rem" }}>reach</span>
          {[
            { m: 1, label: "any" },
            { m: 40, label: "page 1-2" },
            { m: 70, label: "top 10" },
          ].map((o) => (
            <a
              key={o.m}
              href={`/leaks-view?${industry ? `industry=${encodeURIComponent(industry)}&` : ""}min=${o.m}`}
              className={minReach === o.m ? "chip on" : "chip"}
            >
              {o.label}
            </a>
          ))}
        </div>
      </div>

      {worth.length === 0 ? (
        <div className="empty">
          <h3>Nothing rankable here</h3>
          <p>
            A company needs both halves: a recorded search position, and a site whose absences can be trusted.
            Run <code>npm run serp</code> for the first, <code>npm run leaks</code> for the second.
          </p>
        </div>
      ) : (
        <div className="lk-list">
          {worth.map((t) => (
            <LeakCard key={t.companyId} t={t} />
          ))}
        </div>
      )}
    </>
  );
}
