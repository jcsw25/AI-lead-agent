import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { overrideQualification, runQualification } from "./actions";

export const dynamic = "force-dynamic";

const GRADE_CLASS: Record<string, string> = { A: "good", B: "good", C: "", D: "muted" };

const REASON_LABEL: Record<string, string> = {
  NO_CONTACT_ROUTE: "No email or phone anywhere on the site",
  SITE_UNREACHABLE: "Website could not be opened",
  BLOCKED_BY_ROBOTS: "robots.txt disallows crawling",
  AGGREGATOR: "Directory or marketplace, not an operating company",
  NO_PAIRING_THESIS: "No pairing covers this industry — nobody to introduce them to",
  WRONG_INDUSTRY: "Not the industry we searched for",
  OUT_OF_REGION: "Outside the target region",
  DUPLICATE: "Already in the database under another domain",
  SUPPRESSED: "On the suppression list",
  NOT_A_BUSINESS: "Not a business",
  MANUAL: "Scored below the qualification threshold",
};

export default async function QualifiedPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; industry?: string }>;
}) {
  const { status = "QUALIFIED", industry } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const where = {
    businessId: business.id,
    ...(status === "ALL" ? {} : { status: status as "QUALIFIED" | "REVIEW" | "REJECTED" }),
    ...(industry ? { company: { industry: { equals: industry, mode: "insensitive" as const } } } : {}),
  };

  const [rows, counts, model, industries] = await Promise.all([
    db.qualification.findMany({
      where,
      orderBy: [{ score: "desc" }],
      take: 200,
      include: {
        company: {
          select: {
            id: true, name: true, primaryDomain: true, websiteUrl: true, industry: true,
            contacts: { select: { email: true, phone: true, jobTitle: true, fullName: true } },
            siteAudit: { select: { score: true, findings: true, reachable: true } },
          },
        },
      },
    }),
    db.qualification.groupBy({ by: ["status"], where: { businessId: business.id }, _count: { _all: true } }),
    db.scoringModel.findFirst({ where: { businessId: business.id, isActive: true } }),
    db.qualification.findMany({
      where: { businessId: business.id },
      select: { company: { select: { industry: true } } },
      distinct: ["companyId"],
    }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  const total = counts.reduce((s, c) => s + c._count._all, 0);

  const rejected = await db.qualification.groupBy({
    by: ["rejectionReason"],
    where: { businessId: business.id, status: "REJECTED" },
    _count: { _all: true },
    orderBy: { _count: { id: "desc" } },
  });

  const industryList = [...new Set(industries.map((i) => i.company.industry).filter(Boolean))] as string[];

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Scoring · deterministic</p>
        <h1>Qualified</h1>
        <p className="sub">
          Every company scored by arithmetic over weighted, sourced features — no model assigns the number, so
          every score below can be explained line by line and recomputed for free when the weights change.
        </p>
      </div>

      {total === 0 ? (
        <div className="empty">
          <h3>Nothing scored yet</h3>
          <p>Run the scorer over every company in the database. It takes about a second and costs nothing.</p>
          <form action={runQualification.bind(null, business.id)}>
            <button type="submit">Score everything</button>
          </form>
        </div>
      ) : (
        <>
          <div className="stats" style={{ marginBottom: "1.25rem" }}>
            <div className="stat good"><span className="v">{byStatus.QUALIFIED ?? 0}</span><span className="l">Qualified</span></div>
            <div className="stat"><span className="v">{byStatus.REVIEW ?? 0}</span><span className="l">Needs review</span></div>
            <div className="stat muted"><span className="v">{byStatus.REJECTED ?? 0}</span><span className="l">Rejected</span></div>
            <div className="stat"><span className="v">{total}</span><span className="l">Scored</span></div>
          </div>

          <div className="lane-head">
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {["QUALIFIED", "REVIEW", "REJECTED", "ALL"].map((s) => (
                <a
                  key={s}
                  href={`/qualified?status=${s}${industry ? `&industry=${encodeURIComponent(industry)}` : ""}`}
                  className={s === status ? "chip on" : "chip"}
                >
                  {s.toLowerCase()}
                </a>
              ))}
            </div>
            <form action={runQualification.bind(null, business.id)}>
              <button type="submit" className="ghost">Re-score everything</button>
            </form>
          </div>

          {industryList.length > 1 && (
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", margin: "0.75rem 0 1rem" }}>
              <a href={`/qualified?status=${status}`} className={industry ? "chip" : "chip on"}>all industries</a>
              {industryList.map((i) => (
                <a key={i} href={`/qualified?status=${status}&industry=${encodeURIComponent(i)}`}
                   className={industry === i ? "chip on" : "chip"}>{i}</a>
              ))}
            </div>
          )}

          {status === "REJECTED" && rejected.length > 0 && (
            <div className="panel" style={{ marginBottom: "1rem" }}>
              <strong>Why companies were rejected</strong>
              <p className="muted" style={{ margin: "0.3rem 0 0.75rem", fontSize: "0.86rem" }}>
                Rejections are kept, not deleted — the reason stops the same company being rediscovered and
                re-crawled next month, and the distribution is the most honest feedback the system produces
                about whether discovery is finding the right things.
              </p>
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.3rem" }}>
                {rejected.map((r) => (
                  <li key={r.rejectionReason ?? "none"} style={{ display: "flex", gap: "0.75rem" }}>
                    <strong style={{ minWidth: "3rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {r._count._all}
                    </strong>
                    <span>{REASON_LABEL[r.rejectionReason ?? ""] ?? r.rejectionReason ?? "unspecified"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Grade</th><th>Score</th><th>Company</th><th>Industry</th>
                  <th>Contact</th><th>Site</th><th>Why</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => {
                  const email = q.company.contacts.find((c) => c.email)?.email;
                  const phone = q.company.contacts.find((c) => c.phone)?.phone;
                  const factors = (q.factors as Array<{ factor: string; rawValue: number; weight: number; contribution: number; evidence: string }>) ?? [];
                  return (
                    <tr key={q.id}>
                      <td><span className={`pill ${GRADE_CLASS[q.grade] ?? ""}`}>{q.grade}</span></td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{q.score}</td>
                      <td>
                        <strong>{q.company.name}</strong>
                        {q.company.websiteUrl && (
                          <div className="muted" style={{ fontSize: "0.78rem" }}>
                            <a href={q.company.websiteUrl} target="_blank" rel="noopener noreferrer">
                              {q.company.primaryDomain}
                            </a>
                          </div>
                        )}
                      </td>
                      <td className="muted">{q.company.industry ?? "—"}</td>
                      <td style={{ fontSize: "0.82rem" }}>
                        {email ? <div>{email}</div> : null}
                        {phone ? <div className="muted">{phone}</div> : null}
                        {!email && !phone ? <span className="muted">none</span> : null}
                      </td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }} className="muted">
                        {q.company.siteAudit ? `${q.company.siteAudit.score}/100` : "—"}
                      </td>
                      <td style={{ maxWidth: "28rem" }}>
                        <details>
                          <summary style={{ cursor: "pointer", fontSize: "0.84rem" }}>
                            {q.rejectionReason
                              ? (REASON_LABEL[q.rejectionReason] ?? q.rejectionReason)
                              : q.explanation.slice(0, 90) + (q.explanation.length > 90 ? "…" : "")}
                          </summary>
                          <p style={{ fontSize: "0.82rem", margin: "0.5rem 0" }}>{q.explanation}</p>
                          <table style={{ fontSize: "0.75rem" }}>
                            <tbody>
                              {factors.map((f) => (
                                <tr key={f.factor}>
                                  <td>{f.factor}</td>
                                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{f.rawValue}</td>
                                  <td style={{ fontVariantNumeric: "tabular-nums" }} className="muted">×{f.weight}</td>
                                  <td className="muted">{f.evidence}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {q.company.siteAudit?.findings ? (
                            <ul style={{ fontSize: "0.78rem", marginTop: "0.5rem" }}>
                              {((q.company.siteAudit.findings as string[]) ?? []).map((f) => <li key={f}>{f}</li>)}
                            </ul>
                          ) : null}
                        </details>
                      </td>
                      <td>
                        <form action={overrideQualification.bind(null, business.id)}>
                          <input type="hidden" name="companyId" value={q.company.id} />
                          <input type="hidden" name="to" value={q.status === "REJECTED" ? "QUALIFIED" : "REJECTED"} />
                          <button type="submit" className="ghost" style={{ fontSize: "0.75rem" }}>
                            {q.status === "REJECTED" ? "Qualify" : "Reject"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {model && (
            <details className="panel" style={{ marginTop: "1.25rem" }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                Weights · scoring model v{model.version}
              </summary>
              <p className="muted" style={{ fontSize: "0.84rem", marginTop: "0.5rem" }}>
                Weights live in the database, not in code, so they can be refitted from outcomes without a
                deploy and old scores stay reproducible. These are a starting prior — nothing has been sent
                yet, so there are no outcomes to fit against.
              </p>
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {Object.entries((model.weights as Record<string, number>) ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <li key={k} style={{ display: "flex", gap: "0.75rem" }}>
                      <code style={{ minWidth: "10rem" }}>{k}</code>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </>
      )}
    </>
  );
}
