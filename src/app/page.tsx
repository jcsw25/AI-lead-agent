import Link from "next/link";
import { db, dbReady } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";

export const dynamic = "force-dynamic";

export default async function Home() {
  const ready = await dbReady();
  if (!ready.ok) {
    return (
      <>
        <div className="page-head">
          <p className="eyebrow">Not connected</p>
          <h1>The database isn&apos;t running</h1>
        </div>
        <div className="banner err">
          <b>Start it in a second terminal:</b>
          <code>npm run db:dev</code>
        </div>
        <p className="muted">{ready.error}</p>
      </>
    );
  }

  const business = await currentBusiness();
  if (!business) {
    return (
      <div className="empty">
        <h3>No business yet</h3>
        <p>Seed the demo business to explore the system.</p>
        <code>npm run db:seed</code>
      </div>
    );
  }

  const [plays, accepted, prospects, hot, runs, seasons] = await Promise.all([
    db.industryPlay.count({ where: { businessId: business.id, status: "proposed" } }),
    db.industryPlay.count({ where: { businessId: business.id, status: "accepted" } }),
    db.prospect.count({ where: { businessId: business.id } }),
    db.prospect.count({ where: { businessId: business.id, tier: "HOT" } }),
    db.agentRun.count({ where: { businessId: business.id } }),
    db.seasonalWindow.findMany({
      where: { regionId: business.regionId, startsOn: { gte: new Date() } },
      orderBy: { startsOn: "asc" },
      take: 4,
    }),
  ]);

  const topPlays = await db.industryPlay.findMany({
    where: { businessId: business.id, status: { not: "rejected" } },
    orderBy: { score: "desc" },
    take: 4,
  });

  const days = (d: Date) => Math.round((d.getTime() - Date.now()) / 864e5);

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Opportunity centre</p>
        <h1>{business.name}</h1>
        <p className="sub">
          {business.region.name} · {business.offerings.length} offerings ·{" "}
          {hasApiKey() ? "Agents live" : "Agents in simulated mode"}
        </p>
      </div>

      {!hasApiKey() && (
        <div className="banner">
          <b>Simulated mode.</b>
          <span>
            No <code>ANTHROPIC_API_KEY</code> in <code>.env</code>. Agents return illustrative sample output so the
            product is explorable offline. Nothing here is real research.
          </span>
        </div>
      )}

      <div className="stats">
        <div className="stat"><span className="v">{plays}</span><span className="l">Industry plays</span></div>
        <div className="stat good"><span className="v">{accepted}</span><span className="l">Accepted</span></div>
        <div className="stat"><span className="v">{prospects}</span><span className="l">Prospects</span></div>
        <div className="stat hot"><span className="v">{hot}</span><span className="l">Hot leads</span></div>
        <div className="stat"><span className="v">{runs}</span><span className="l">Agent runs</span></div>
      </div>

      <h2>Buying windows ahead</h2>
      <div className="grid two">
        {seasons.map((s) => {
          const until = days(s.startsOn);
          const outreachIn = until - s.buyingLeadDays;
          return (
            <div key={s.id} className="card">
              <div className="play-top">
                <div>
                  <h3 style={{ margin: 0, fontFamily: "IBM Plex Sans Condensed, sans-serif", fontSize: "1.05rem" }}>
                    {s.name}
                  </h3>
                  <span className="motion">{s.startsOn.toISOString().slice(0, 10)}</span>
                </div>
                <span className="score-chip">{until}d</span>
              </div>
              <p className="muted" style={{ margin: ".5rem 0 0" }}>
                {outreachIn <= 0
                  ? `Outreach window is open now — buyers decide ~${s.buyingLeadDays} days ahead.`
                  : `Start outreach in ${outreachIn} days (${s.buyingLeadDays}-day lead).`}
              </p>
            </div>
          );
        })}
      </div>

      <h2>Top industry plays</h2>
      {topPlays.length === 0 ? (
        <div className="empty">
          <h3>Nothing scouted yet</h3>
          <p>Find out which markets are worth going after, and why now.</p>
          <Link className="btn" href="/industries">Scout industries</Link>
        </div>
      ) : (
        <div className="grid two">
          {topPlays.map((p) => (
            <article key={p.id} className="card play">
              <div className="play-top">
                <div>
                  <h3>{p.industry}</h3>
                  <span className={`lane lane-${p.lane}`}>{p.lane}</span>
                </div>
                <span className="score-chip">{Math.round(p.score * 100)}</span>
              </div>
              <p>{p.buyingTrigger}</p>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
