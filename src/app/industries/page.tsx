import { db } from "@/lib/db";
import { currentBusiness, LANE_COPY, LANE_ORDER } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { scoutIndustries, setPlayStatus, clearPlays } from "./actions";

export const dynamic = "force-dynamic";

function Bar({ label, value, invert = false }: { label: string; value: number; invert?: boolean }) {
  return (
    <div className={`bar${invert ? " inv" : ""}`}>
      <div className="bl">
        <span>{label}</span>
        <span>{Math.round(value * 100)}</span>
      </div>
      <div className="track">
        <div className="fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

export default async function IndustriesPage() {
  const business = await currentBusiness();
  if (!business) return <p>No business found. Run <code>npm run db:seed</code>.</p>;

  const plays = await db.industryPlay.findMany({
    where: { businessId: business.id, status: { not: "rejected" } },
    orderBy: { score: "desc" },
  });

  const simulated = !hasApiKey();
  const money = (lo: unknown, hi: unknown, ccy: string) =>
    lo && hi ? `${ccy} ${Number(lo).toLocaleString()}–${Number(hi).toLocaleString()}` : null;

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Industry scout</p>
        <h1>Which markets should we go after?</h1>
        <p className="sub">
          The scout searches the whole economy across six lanes, not just the industries next door to what you
          already sell. Every play must carry a thesis (why them) and a trigger (why now) — a market with no
          clock is not a play.
        </p>
      </div>

      {simulated && (
        <div className="banner">
          <b>Simulated data.</b>
          <span>
            No <code>ANTHROPIC_API_KEY</code> is set, so these plays are illustrative samples showing the shape of the
            output — no research was performed. Add a key to <code>.env</code> and re-run the scout for real results.
          </span>
        </div>
      )}

      <div className="actions" style={{ marginBottom: "1.5rem" }}>
        <form action={scoutIndustries.bind(null, business.id)}>
          <button className="btn" type="submit">
            {plays.length ? "Scout again" : "Scout industries"}
          </button>
        </form>
        {plays.length > 0 && (
          <form action={clearPlays.bind(null, business.id)}>
            <button className="btn ghost" type="submit">Clear all</button>
          </form>
        )}
        <span className="muted">
          {plays.length} plays for <b>{business.name}</b> · {business.region.name}
        </span>
      </div>

      {plays.length === 0 ? (
        <div className="empty">
          <h3>No industry plays yet</h3>
          <p>
            Run the scout to generate ranked target markets across all six lanes, each with a buying trigger and the
            role that holds the budget.
          </p>
          <form action={scoutIndustries.bind(null, business.id)}>
            <button className="btn" type="submit">Scout industries</button>
          </form>
        </div>
      ) : (
        LANE_ORDER.map((lane) => {
          const inLane = plays.filter((p) => p.lane === lane);
          if (!inLane.length) return null;
          return (
            <section key={lane}>
              <div className="lane-head">
                <h2>{LANE_COPY[lane].title}</h2>
                <span className={`lane lane-${lane}`}>{lane}</span>
              </div>
              <p className="muted" style={{ margin: "0 0 .9rem", maxWidth: "68ch" }}>{LANE_COPY[lane].blurb}</p>
              <div className="grid two">
                {inLane.map((p) => (
                  <article key={p.id} className="card play" style={{ borderLeftColor: `var(--${laneVar(p.lane)})` }}>
                    <div className="play-top">
                      <div>
                        <h3>{p.industry}</h3>
                        <span className="motion">
                          {p.motion}
                          {p.subIndustry ? ` · ${p.subIndustry}` : ""}
                          {p.status === "accepted" ? " · ACCEPTED" : ""}
                        </span>
                      </div>
                      <span className="score-chip">{Math.round(p.score * 100)}</span>
                    </div>

                    <p className="why">{p.thesis}</p>

                    <dl>
                      <dt>Why now</dt>
                      <dd>{p.buyingTrigger}</dd>
                      {p.timingWindow && (
                        <>
                          <dt>Reach out</dt>
                          <dd>{p.timingWindow}</dd>
                        </>
                      )}
                      <dt>Who holds the budget</dt>
                      <dd>{p.reachVia.join(" · ")}</dd>
                      {money(p.dealSizeLow, p.dealSizeHigh, p.currency) && (
                        <>
                          <dt>Typical deal</dt>
                          <dd className="mono">{money(p.dealSizeLow, p.dealSizeHigh, p.currency)}</dd>
                        </>
                      )}
                    </dl>

                    <div className="bars">
                      <Bar label="Demand" value={p.demandStrength} />
                      <Bar label="Reach" value={p.reachability} />
                      <Bar label="Crowded" value={p.competitionLevel} invert />
                      <Bar label="Confidence" value={p.confidence} />
                    </div>

                    <div className="actions">
                      {p.status !== "accepted" && (
                        <form action={setPlayStatus.bind(null, p.id, "accepted")}>
                          <button className="btn ghost" type="submit">Accept</button>
                        </form>
                      )}
                      <form action={setPlayStatus.bind(null, p.id, "rejected")}>
                        <button className="btn ghost" type="submit">Dismiss</button>
                      </form>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}

function laneVar(lane: string) {
  switch (lane) {
    case "SEASONAL": return "ochre";
    case "TRIGGER": return "good";
    case "CONTRARIAN": return "crit";
    case "ADJACENT": return "ink-faint";
    default: return "accent";
  }
}
