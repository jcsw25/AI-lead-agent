import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { money } from "@/lib/pipeline";
import {
  approveAndSend, designSolution, draftOutreach, logDiscoveryCall, logReply,
  matchProspect, setMatchStatus, setProposalStatus, setTier,
} from "../actions";

export const dynamic = "force-dynamic";

const REPLIES: Array<[string, string, string]> = [
  ["HOT", "Interested — wants pricing", "Yes, please send pricing and lead times for 200 units."],
  ["WARM", "Curious — wants more info", "Sounds interesting, could you send more information?"],
  ["COLD", "Not now", "Maybe next year, we've already committed this cycle."],
  ["NEGATIVE", "Not interested", "No thanks."],
  ["WRONG_CONTACT", "Wrong person", "I'm not the right person — try our procurement team."],
  ["UNSUBSCRIBE", "Opt out", "Please remove me from your mailing list."],
];

export default async function ProspectDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const p = await db.prospect.findUnique({
    where: { id },
    include: {
      company: { include: { signals: { orderBy: { observedAt: "desc" } } } },
      play: true,
      business: true,
      contacts: { include: { contact: true }, orderBy: { isPrimary: "desc" } },
      matches: { include: { product: { include: { supplier: true } } }, orderBy: { fitScore: "desc" } },
      calls: { orderBy: { heldAt: "desc" } },
      proposals: { orderBy: { createdAt: "desc" } },
      activities: { orderBy: { occurredAt: "desc" }, take: 20 },
    },
  });
  if (!p) notFound();

  const messages = await db.message.findMany({
    where: { OR: [{ matchId: { in: p.matches.map((m) => m.id) } }, { contactId: { in: p.contacts.map((c) => c.contactId) } }] },
    orderBy: { createdAt: "desc" },
  });

  const match = p.matches[0];
  const draft = messages.find((m) => m.direction === "OUTBOUND" && m.status === "PENDING_APPROVAL");
  const isService = match?.product.kind === "SERVICE";
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">
          <Link href="/prospects">← Pipeline</Link>
          {p.play ? ` · ${p.play.industry}` : ""}
        </p>
        <h1>{p.company.name}</h1>
        <p className="sub">
          {p.company.industry ?? "—"}
          {p.company.employeeBand ? ` · ${p.company.employeeBand} employees` : ""}
          {p.company.city ? ` · ${p.company.city}` : ""} · stage <b>{p.stage}</b>
          {p.tier ? ` · ${p.tier}` : ""}
        </p>
      </div>

      {p.company.verification === "UNVERIFIED" && (
        <div className="banner">
          <b>Unverified.</b>
          <span>This company record has no confirmed source, so it cannot raise a lead score or be quoted in outbound copy.</span>
        </div>
      )}

      <div className="split">
        <div>
          {/* ---- the deal ---- */}
          <h2>The deal</h2>
          {!match ? (
            <div className="empty">
              <h3>No product matched</h3>
              <p>Pick the best thing to put in front of them, from your own catalogue or a partner&apos;s.</p>
              <form action={matchProspect.bind(null, p.businessId, p.id)}>
                <button className="btn" type="submit">Match a product</button>
              </form>
            </div>
          ) : (
            p.matches.map((m) => (
              <div key={m.id} className="card play" style={{ marginBottom: ".75rem" }}>
                <div className="play-top">
                  <div>
                    <h3>{m.product.name}</h3>
                    <span className="motion">
                      {m.product.supplier.isSelf ? "Our own product" : `Brokered — ${m.product.supplier.name}`} · {m.status}
                    </span>
                  </div>
                  <span className="score-chip">{Math.round(m.fitScore * 100)}</span>
                </div>
                <p>{m.rationale}</p>
                <dl>
                  <dt>Estimated deal</dt>
                  <dd className="mono">{money(m.estimatedDealValue, m.currency) ?? "not estimated"}</dd>
                  <dt>Our cut</dt>
                  <dd className="mono">
                    {m.commissionModel === "NONE"
                      ? "Full revenue (own product)"
                      : `${money(m.estimatedCommission, m.currency) ?? "—"} · ${m.commissionRate ? `${Number(m.commissionRate)}%` : m.commissionModel}`}
                  </dd>
                  {!m.product.supplier.isSelf && (
                    <>
                      <dt>Supplier contact</dt>
                      <dd>{m.product.supplier.contactEmail ?? "not recorded"}</dd>
                    </>
                  )}
                </dl>
                <div className="actions">
                  {["APPROVED", "PITCHED", "INTERESTED"].includes(m.status) && (
                    <form action={setMatchStatus.bind(null, m.id, "INTRODUCED", p.id)}>
                      <button className="btn" type="submit">Mark introduced</button>
                    </form>
                  )}
                  {m.status === "INTRODUCED" && (
                    <>
                      <form action={setMatchStatus.bind(null, m.id, "WON", p.id)}>
                        <button className="btn" type="submit">Won</button>
                      </form>
                      <form action={setMatchStatus.bind(null, m.id, "LOST", p.id)}>
                        <button className="btn ghost" type="submit">Lost</button>
                      </form>
                    </>
                  )}
                </div>
              </div>
            ))
          )}

          {/* ---- outreach ---- */}
          <h2>Outreach</h2>
          {!match ? (
            <p className="muted">Match a product first — the email is written around the specific product.</p>
          ) : draft ? (
            <div className="card">
              <div className="mono muted" style={{ fontSize: ".72rem", marginBottom: ".4rem" }}>
                DRAFT · PENDING APPROVAL
              </div>
              <p style={{ margin: "0 0 .5rem" }}>
                <b>Subject:</b> {draft.subject}
              </p>
              <pre className="email">{draft.bodyText}</pre>
              {draft.classifierNotes && (
                <div className="banner err" style={{ margin: ".75rem 0 0" }}>
                  <b>Unverified claims flagged.</b>
                  <span>{draft.classifierNotes}</span>
                </div>
              )}
              <div className="actions" style={{ marginTop: ".9rem" }}>
                <form action={approveAndSend.bind(null, draft.id, p.id)}>
                  <button className="btn" type="submit">Approve &amp; send</button>
                </form>
                <form action={draftOutreach.bind(null, p.businessId, match.id, p.id)}>
                  <button className="btn ghost" type="submit">Rewrite</button>
                </form>
              </div>
            </div>
          ) : (
            <div className="empty">
              <h3>No draft yet</h3>
              <p>Write a cold email built around {match.product.name} and the reason they&apos;d buy now.</p>
              <form action={draftOutreach.bind(null, p.businessId, match.id, p.id)}>
                <button className="btn" type="submit">Write outreach</button>
              </form>
            </div>
          )}

          {/* ---- services: discovery call -> scoped solution ---- */}
          {isService && (
            <>
              <h2>Discovery &amp; scoping</h2>
              <p className="muted" style={{ marginTop: "-.4rem" }}>
                A service can&apos;t be quoted cold. Have the call, capture what actually hurts, then scope against
                it — the designer may only build phases around problems recorded here.
              </p>

              {p.calls.length > 0 && (
                <div className="grid" style={{ marginBottom: "1rem" }}>
                  {p.calls.map((c) => (
                    <div key={c.id} className="card play">
                      <div className="play-top">
                        <div>
                          <h3>Discovery call</h3>
                          <span className="motion">
                            {c.heldAt.toISOString().slice(0, 16).replace("T", " ")}
                            {c.attendees.length ? ` · ${c.attendees.join(", ")}` : ""}
                          </span>
                        </div>
                      </div>
                      <dl>
                        <dt>Problems stated</dt>
                        <dd>
                          <ul className="notes">
                            {arr<{ problem?: string }>(c.problemsIdentified).map((x, n) => (
                              <li key={n}>{x.problem ?? String(x)}</li>
                            ))}
                          </ul>
                        </dd>
                        {c.systemsMentioned.length > 0 && (
                          <>
                            <dt>Systems</dt>
                            <dd>{c.systemsMentioned.join(" · ")}</dd>
                          </>
                        )}
                        {c.budgetSignal && (<><dt>Budget signal</dt><dd>{c.budgetSignal}</dd></>)}
                        {c.timelineSignal && (<><dt>Timeline</dt><dd>{c.timelineSignal}</dd></>)}
                      </dl>
                      {c.notes && <pre className="email">{c.notes}</pre>}
                      <div className="actions">
                        <form action={designSolution.bind(null, p.businessId, c.id, p.id)}>
                          <button className="btn" type="submit">Scope a solution</button>
                        </form>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <details className="card" open={p.calls.length === 0}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>Log a discovery call</summary>
                <form action={logDiscoveryCall.bind(null, p.businessId, p.id, match?.id ?? null)} className="callform">
                  <label>
                    Who was on the call
                    <input name="attendees" placeholder="One name per line" />
                  </label>
                  <label>
                    Problems they stated{" "}
                    <span className="muted">— one per line. The designer may only use these.</span>
                    <textarea name="problems" rows={4} defaultValue={"Three staff re-key orders from email into the ERP\nMonth-end reconciliation takes four days\nNo stock visibility until it is counted"} />
                  </label>
                  <label>
                    Systems mentioned
                    <textarea name="systems" rows={2} defaultValue={"SAP\nExcel\nShopify"} />
                  </label>
                  <div className="two-up">
                    <label>Budget signal<input name="budget" placeholder="has ~50k allocated this FY" /></label>
                    <label>Timeline signal<input name="timeline" placeholder="wants it before peak season" /></label>
                  </div>
                  <label>
                    Notes
                    <textarea name="notes" rows={4} defaultValue={"Ops lead says the team works two Saturdays a month just to clear the backlog. Nobody owns the integration."} />
                  </label>
                  <label>Next step<input name="nextStep" placeholder="send scoped audit proposal by Friday" /></label>
                  <button className="btn" type="submit">Save call</button>
                </form>
              </details>

              {p.proposals.length > 0 && (
                <>
                  <h2>Proposals</h2>
                  <div className="grid">
                    {p.proposals.map((pr) => (
                      <article key={pr.id} className="card play">
                        <div className="play-top">
                          <div>
                            <h3>{pr.title}</h3>
                            <span className="motion">{pr.status.toUpperCase()} · {pr.estimatedDays ?? "?"} days</span>
                          </div>
                          <span className="score-chip">{money(pr.estimatedValue, pr.currency)}</span>
                        </div>
                        <p className="why">{pr.summary}</p>

                        <dl>
                          <dt>Problems addressed</dt>
                          <dd>
                            <ul className="notes">
                              {arr<{ problem?: string; solution?: string }>(pr.problemsAddressed).map((a, n) => (
                                <li key={n}><b>{a.problem}</b> — {a.solution}</li>
                              ))}
                            </ul>
                          </dd>
                        </dl>

                        <ol className="phases">
                          {arr<{ name?: string; days?: number; description?: string; deliverable?: string }>(pr.phases).map((ph, n) => (
                            <li key={n}>
                              <b>{ph.name ?? `Phase ${n + 1}`}</b>
                              <span className="mono muted"> · {ph.days ?? "?"}d</span>
                              <div className="muted">{ph.description}</div>
                              <div className="muted"><i>Deliverable:</i> {ph.deliverable}</div>
                            </li>
                          ))}
                        </ol>

                        <dl>
                          <dt>Risks</dt>
                          <dd>
                            <ul className="notes">
                              {arr<{ risk?: string; mitigation?: string }>(pr.risks).map((r, n) => (
                                <li key={n}>{r.risk} <span className="muted">— {r.mitigation}</span></li>
                              ))}
                            </ul>
                          </dd>
                          <dt>Our cut</dt>
                          <dd className="mono">{money(pr.estimatedCommission, pr.currency) ?? "own delivery — full revenue"}</dd>
                        </dl>

                        <div className="actions">
                          {pr.status === "draft" && (
                            <form action={setProposalStatus.bind(null, pr.id, "sent", p.id)}>
                              <button className="btn ghost" type="submit">Mark sent</button>
                            </form>
                          )}
                          {pr.status !== "accepted" && (
                            <form action={setProposalStatus.bind(null, pr.id, "accepted", p.id)}>
                              <button className="btn" type="submit">Accepted — won</button>
                            </form>
                          )}
                          <form action={setProposalStatus.bind(null, pr.id, "rejected", p.id)}>
                            <button className="btn ghost" type="submit">Rejected</button>
                          </form>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {/* ---- conversation ---- */}
          <h2>Conversation</h2>
          {messages.filter((m) => m.status !== "PENDING_APPROVAL").length === 0 ? (
            <p className="muted">Nothing sent yet.</p>
          ) : (
            <div className="grid">
              {messages
                .filter((m) => m.status !== "PENDING_APPROVAL")
                .map((m) => (
                  <div key={m.id} className={`card msg ${m.direction === "INBOUND" ? "in" : "out"}`}>
                    <div className="mono muted" style={{ fontSize: ".7rem" }}>
                      {m.direction === "INBOUND" ? "REPLY" : "SENT"}
                      {m.replyClass ? ` · ${m.replyClass}` : ""} ·{" "}
                      {(m.sentAt ?? m.repliedAt ?? m.createdAt).toISOString().slice(0, 16).replace("T", " ")}
                    </div>
                    <p style={{ margin: ".3rem 0 0" }}><b>{m.subject}</b></p>
                    <pre className="email">{m.bodyText}</pre>
                  </div>
                ))}
            </div>
          )}

          <h3>Log a reply</h3>
          <p className="muted">
            Until the inbox is connected, use this to move the pipeline. It writes a real inbound message and
            reclassifies the lead exactly as a live reply would.
          </p>
          <div className="actions">
            {REPLIES.map(([cls, label, text]) => (
              <form key={cls} action={logReply.bind(null, p.id, cls as never, text)}>
                <button className="btn ghost" type="submit">{label}</button>
              </form>
            ))}
          </div>
        </div>

        {/* ---- sidebar ---- */}
        <aside>
          <h2>Key people</h2>
          {p.contacts.length === 0 ? (
            <p className="muted">None identified.</p>
          ) : (
            <div className="grid">
              {p.contacts.map((pc) => (
                <div key={pc.id} className="card">
                  <b>{pc.contact.fullName}</b>
                  <div className="muted">{pc.contact.jobTitle}{pc.contact.department ? ` · ${pc.contact.department}` : ""}</div>
                  <div className="mono muted" style={{ fontSize: ".78rem", wordBreak: "break-all" }}>{pc.contact.email}</div>
                  {pc.rationale && <p className="muted" style={{ margin: ".5rem 0 0", fontSize: ".85rem" }}>{pc.rationale}</p>}
                </div>
              ))}
            </div>
          )}

          <h2>Classify</h2>
          <div className="actions">
            {(["HOT", "WARM", "COLD"] as const).map((t) => (
              <form key={t} action={setTier.bind(null, p.id, t)}>
                <button className="btn ghost" type="submit">{t}</button>
              </form>
            ))}
          </div>

          {p.play && (
            <>
              <h2>Why we targeted them</h2>
              <div className="card">
                <span className={`lane lane-${p.play.lane}`}>{p.play.lane}</span>
                <p style={{ margin: ".5rem 0 0", fontSize: ".9rem" }}>{p.play.thesis}</p>
                <p className="muted" style={{ margin: ".5rem 0 0", fontSize: ".85rem" }}>
                  <b>Why now:</b> {p.play.buyingTrigger}
                </p>
              </div>
            </>
          )}

          {p.company.signals.length > 0 && (
            <>
              <h2>Signals</h2>
              <div className="grid">
                {p.company.signals.map((s) => (
                  <div key={s.id} className="card">
                    <b style={{ fontSize: ".9rem" }}>{s.title}</b>
                    <div className="muted" style={{ fontSize: ".8rem" }}>
                      {s.verification} · {s.observedAt.toISOString().slice(0, 10)}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <h2>Timeline</h2>
          <ol className="timeline">
            {p.activities.map((a) => (
              <li key={a.id}>
                <span className="mono">{a.occurredAt.toISOString().slice(5, 16).replace("T", " ")}</span>
                <span>{a.summary}</span>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </>
  );
}
