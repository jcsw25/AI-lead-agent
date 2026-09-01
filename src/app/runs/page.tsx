import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await db.agentRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 });
  const total = runs.reduce((s, r) => s + Number(r.costUsd ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Observability</p>
        <h1>Agent runs</h1>
        <p className="sub">
          Every model invocation is a row: input hash, model, tokens, cost and latency. This is the audit trail
          and the cost meter — an autonomous loop needs both.
        </p>
      </div>

      <div className="stats" style={{ marginBottom: "1.5rem" }}>
        <div className="stat"><span className="v">{runs.length}</span><span className="l">Recent runs</span></div>
        <div className="stat"><span className="v">${total.toFixed(4)}</span><span className="l">Total cost</span></div>
      </div>

      {runs.length === 0 ? (
        <div className="empty"><h3>No runs yet</h3><p>Scout some industries to generate one.</p></div>
      ) : (
        <div className="grid">
          {runs.map((r) => (
            <article key={r.id} className="card play">
              <div className="play-top">
                <div>
                  <h3>{r.agent}</h3>
                  <span className="motion">
                    {r.model} · {r.status} · {r.latencyMs ?? "—"}ms · {r.startedAt.toISOString().slice(0, 19).replace("T", " ")}
                  </span>
                </div>
                <span className="score-chip">${Number(r.costUsd ?? 0).toFixed(4)}</span>
              </div>
              {r.errorDetail && <p className="muted">{r.errorDetail}</p>}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
