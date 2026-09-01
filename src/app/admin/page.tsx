import { currentBusiness } from "@/lib/business";
import { runHealthChecks, type ProbeStatus } from "@/lib/health";
import { getProjectStatus } from "@/lib/project-status";
import { recentChanges } from "@/lib/changelog";
import { recheck } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<ProbeStatus, string> = {
  live: "LIVE",
  degraded: "CHECK",
  error: "ERROR",
  not_configured: "NOT SET",
};

const STATUS_TONE: Record<ProbeStatus, string> = {
  live: "lane-TRIGGER",
  degraded: "lane-SEASONAL",
  error: "lane-CONTRARIAN",
  not_configured: "lane-ADJACENT",
};

const STAGE_MARK: Record<string, string> = {
  working: "✓",
  partial: "◐",
  not_started: "○",
};

export default async function AdminPage() {
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const [probes, status, changes] = await Promise.all([
    runHealthChecks(business.id),
    getProjectStatus(business.id),
    recentChanges(business.id, 40),
  ]);

  const broken = probes.filter((p) => p.status === "error");
  const attention = probes.filter((p) => p.status === "degraded" || p.status === "not_configured");

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Admin · system health and project state</p>
        <h1>Admin</h1>
        <p className="sub">
          Every connection below was tested with a real call just now, not read from a config file. A rotated
          key, an exhausted quota and a typo all look identical in <code>.env</code>; only a live call tells
          them apart.
        </p>
      </div>

      {broken.length > 0 && (
        <div className="notice" style={{ marginBottom: "1rem", borderColor: "var(--bad, #982f2f)" }}>
          <strong>
            {broken.length} connection{broken.length === 1 ? "" : "s"} failing:
          </strong>{" "}
          {broken.map((b) => b.name).join(", ")}. Details below.
        </div>
      )}

      <div className="lane-head">
        <h2>Connections</h2>
        <form action={recheck}>
          <button type="submit" className="ghost">Re-check now</button>
        </form>
      </div>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Service</th><th>Status</th><th>What the check found</th><th>If it breaks</th><th>Latency</th>
            </tr>
          </thead>
          <tbody>
            {probes.map((p) => (
              <tr key={p.key}>
                <td>
                  <strong>{p.name}</strong>
                  {p.cost && <div className="muted" style={{ fontSize: "0.72rem" }}>{p.cost}</div>}
                </td>
                <td><span className={`lane ${STATUS_TONE[p.status]}`}>{STATUS_LABEL[p.status]}</span></td>
                <td style={{ maxWidth: "26rem", fontSize: "0.86rem" }}>{p.detail}</td>
                <td className="muted" style={{ maxWidth: "20rem", fontSize: "0.8rem" }}>{p.impact}</td>
                <td className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {p.latencyMs ? `${p.latencyMs}ms` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {attention.length > 0 && (
        <p className="muted" style={{ fontSize: "0.84rem", marginTop: "0.6rem" }}>
          <strong>CHECK</strong> means connected but not doing its job — a stale Sheet, or Gmail authorised
          while <code>EMAIL_ADAPTER</code> still points elsewhere. <strong>NOT SET</strong> means the
          credentials were never supplied, which is a choice rather than a fault.
        </p>
      )}

      {/* ---------------- pipeline ---------------- */}
      <div className="lane-head" style={{ marginTop: "2.5rem" }}>
        <h2>Pipeline</h2>
        <span className="muted">every figure is a query, not a note</span>
      </div>

      <div className="scroll">
        <table>
          <thead>
            <tr><th></th><th>Stage</th><th>Measured</th><th>Note</th></tr>
          </thead>
          <tbody>
            {status.stages.map((s) => (
              <tr key={s.name}>
                <td style={{ width: "2rem", fontSize: "1.1rem" }}
                    className={s.status === "working" ? "good" : s.status === "not_started" ? "muted" : ""}>
                  {STAGE_MARK[s.status]}
                </td>
                <td><strong>{s.name}</strong></td>
                <td style={{ fontSize: "0.88rem" }}>{s.measured}</td>
                <td className="muted" style={{ maxWidth: "28rem", fontSize: "0.82rem" }}>{s.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------------- spend ---------------- */}
      <div className="lane-head" style={{ marginTop: "2.5rem" }}>
        <h2>Model spend</h2>
        <span className="muted">${status.spend.totalUsd.toFixed(2)} total, all time</span>
      </div>

      {status.spend.byAgent.length === 0 ? (
        <p className="muted">No model calls recorded yet.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead><tr><th>Agent</th><th>Runs</th><th>Cost</th><th>Per run</th></tr></thead>
            <tbody>
              {status.spend.byAgent.map((a) => (
                <tr key={a.agent}>
                  <td>{a.agent.toLowerCase().replace(/_/g, " ")}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{a.runs}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>${a.usd.toFixed(3)}</td>
                  <td className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                    ${a.runs ? (a.usd / a.runs).toFixed(4) : "0"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- recommendations ---------------- */}
      <div className="lane-head" style={{ marginTop: "2.5rem" }}>
        <h2>What I&rsquo;d do next</h2>
        <span className="muted">derived from the state above</span>
      </div>

      <div style={{ display: "grid", gap: "0.75rem" }}>
        {status.recommendations.map((r) => (
          <div key={r.title} className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
              <strong>{r.title}</strong>
              <span className={`lane ${r.priority === "now" ? "lane-TRIGGER" : r.priority === "next" ? "lane-SEASONAL" : "lane-ADJACENT"}`}>
                {r.priority.toUpperCase()}
              </span>
            </div>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.9rem" }}>{r.why}</p>
            <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.8rem" }}>Effort: {r.effort}</p>
          </div>
        ))}
      </div>

      {/* ---------------- change log ---------------- */}
      <div className="lane-head" style={{ marginTop: "2.5rem" }}>
        <h2>What changed</h2>
        <span className="muted">{changes.length} entries · written by the code that made the change</span>
      </div>

      <p className="muted" style={{ fontSize: "0.84rem", marginTop: "-0.5rem", marginBottom: "1rem" }}>
        Every entry states what it was before and what it is now, because &ldquo;improved the scoring&rdquo; is
        not a change description &mdash; &ldquo;rejected 14 aggregators, now rejects 33&rdquo; is, and it can be
        checked.
      </p>

      <div style={{ display: "grid", gap: "0.75rem" }}>
        {changes.map((c) => (
          <div key={c.id} className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
              <strong>{c.title}</strong>
              <span className="muted" style={{ fontSize: "0.74rem", whiteSpace: "nowrap" }}>
                <span className="lane lane-ADJACENT">{c.area}</span>{" "}
                {c.createdAt.toLocaleDateString()}
              </span>
            </div>

            <div style={{ display: "grid", gap: "0.6rem", marginTop: "0.7rem" }}>
              <div style={{ borderLeft: "3px solid var(--rule, #555)", paddingLeft: "0.8rem" }}>
                <div className="muted" style={{ fontSize: "0.68rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  Before
                </div>
                <div style={{ fontSize: "0.88rem" }}>{c.before}</div>
              </div>
              <div style={{ borderLeft: "3px solid var(--good, #2d6a44)", paddingLeft: "0.8rem" }}>
                <div className="muted" style={{ fontSize: "0.68rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  After
                </div>
                <div style={{ fontSize: "0.88rem" }}>{c.after}</div>
              </div>
            </div>

            <p className="muted" style={{ margin: "0.7rem 0 0", fontSize: "0.84rem" }}>
              <strong>Why:</strong> {c.why}
            </p>
            {c.impact && (
              <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.84rem" }}>
                <strong>Impact:</strong> {c.impact}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* ---------------- recent activity ---------------- */}
      <div className="lane-head" style={{ marginTop: "2.5rem" }}>
        <h2>Recent activity</h2>
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>When</th><th>Kind</th><th>What</th><th>Status</th><th>Result</th></tr></thead>
          <tbody>
            {status.recentRuns.map((r, i) => (
              <tr key={i}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{r.when.toLocaleString()}</td>
                <td>{r.kind}</td>
                <td>{r.label}</td>
                <td className={r.status === "failed" ? "bad" : r.status === "running" ? "" : "good"}>{r.status}</td>
                <td className="muted">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
