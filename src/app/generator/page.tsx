import Link from "next/link";
import { db } from "@/lib/db";
import { pitchPriority } from "@/lib/scoring/pitch-priority";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { money } from "@/lib/pipeline";
import { classifyAndLink } from "@/agents/company-classifier";
import { serviceAccountEmail, sheetsConfigured } from "@/adapters/sheets";
import { googleConfigured } from "@/adapters/search";
import { connectSheet, disconnectSheet, draftPair, enrichIndustry, replanIndustry, searchCompany, searchIndustry, syncSheet } from "./actions";
import { SearchButton } from "./SearchButton";
import { RunProgress, type Stage } from "./RunProgress";

export const dynamic = "force-dynamic";

export default async function GeneratorPage({
  searchParams,
}: {
  searchParams: Promise<{
    company?: string; notfound?: string; sheeterror?: string;
    industry?: string; found?: string; saved?: string; drafted?: string; nocontact?: string;
    enriched?: string; emails?: string; phones?: string; remaining?: string; enriching?: string;
  }>;
}) {
  const { company: companyId, notfound, sheeterror, industry: shown, found, saved, drafted, nocontact,
    enriched, emails: emailsFound, phones: phonesFound, remaining, enriching: justQueued } = await searchParams;
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  // A run whose process died mid-search stays "running" forever and makes the
  // log lie. Nothing takes 15 minutes, so close them out on load.
  await db.scrapeRun.updateMany({
    where: { businessId: business.id, status: "running", startedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
    data: { status: "failed", error: "Did not complete — the server restarted or the search was interrupted.", finishedAt: new Date() },
  });

  const [runs, totals, recentCompanies, industries] = await Promise.all([
    db.scrapeRun.findMany({
      where: { businessId: business.id, mode: "search" },
      orderBy: { startedAt: "desc" },
      take: 6,
    }),
    Promise.all([
      db.company.count(),
      db.contact.count({ where: { email: { not: null } } }),
      db.supplierLead.count({ where: { businessId: business.id } }),
      db.pairing.count({ where: { businessId: business.id } }),
    ]),
    db.company.findMany({
      orderBy: { lastResearchedAt: "desc" },
      take: 10,
      include: { contacts: { take: 1 } },
    }),
    db.pairing.findMany({
      where: { businessId: business.id },
      select: { supplierIndustry: true, buyerIndustry: true },
      orderBy: { score: "desc" },
      take: 40,
    }),
  ]);

  const [companyCount, emailCount, leadCount, pairingCount] = totals;

  const suggested = [...new Set(industries.flatMap((i) => [i.supplierIndustry, i.buyerIndustry]))].slice(0, 14);

  // Industry mode: the companies that search just produced.
  const results = shown
    ? await db.company.findMany({
        where: { industry: { equals: shown, mode: "insensitive" } },
        include: { contacts: true },
        orderBy: [{ lastResearchedAt: "desc" }],
        take: 100,
      })
    : [];

  // Who in this trade has traffic they are losing. Only companies with a
  // recorded search position appear — reach is the half that decides whether
  // the pitch is even true.
  const pitch = shown ? await pitchPriority({ industry: shown, limit: 10, minReach: 1 }) : [];

  // The searches that produced this list. Without it a thin result set is
  // indistinguishable from a badly phrased query — you cannot tell whether the
  // market is small or the vocabulary was wrong.
  const plan = shown
    ? await db.queryPlan.findFirst({
        where: { industry: { equals: shown, mode: "insensitive" } },
        orderBy: { updatedAt: "desc" },
      })
    : null;
  const planQueriesList = (plan?.queries as Array<{ query: string; intent: string; why: string }> | null) ?? [];

  // Discovery stores what Google returned; the email lives on the company's own
  // site and only exists here once that site has been opened.
  const enriching = await (await import("@/lib/jobs/enrich-queue")).currentEnrichment(business.id);

  // The three things that can independently be in progress or finished after a
  // search. Only shown for the industry just searched, so an old run does not
  // hang around claiming to be working.
  const thisRun = enriching && shown && enriching.industry.toLowerCase() === shown.toLowerCase() ? enriching : null;
  const crawlRunning = Boolean(thisRun && !thisRun.finished);
  // Keep polling until EVERY stage has resolved, not just the crawl.
  //
  // Tying the refresh to the crawl alone froze the page one second before the
  // Sheet write landed, so the last light stayed grey over a Sheet that had
  // actually been updated. A stage that is still pending is a reason to keep
  // looking.
  const sheetPending = Boolean(thisRun && !thisRun.sheetSynced && !thisRun.sheetError);
  const stillWorking = crawlRunning || sheetPending;
  const progressStages: Stage[] | null = thisRun
    ? [
        {
          key: "search",
          label: `Found ${found ?? results.length} companies in ${shown}`,
          state: "done",
          detail: saved ? `${saved} new, the rest already in the database` : undefined,
        },
        {
          key: "crawl",
          label: crawlRunning
            ? `Opening websites — ${thisRun.done} of ${thisRun.total}`
            : `Opened ${thisRun.done} websites`,
          state: crawlRunning ? "running" : "done",
          detail: `${thisRun.emails} emails and ${thisRun.phones} phone numbers found so far`,
        },
        {
          key: "sheet",
          label: thisRun.sheetSynced
            ? "Imported into Google Sheets"
            : crawlRunning
              ? "Google Sheets — waiting for the crawl to finish"
              : thisRun.sheetError
                ? `Google Sheets — not written (${thisRun.sheetError})`
                : "Google Sheets",
          state: thisRun.sheetSynced ? "done" : crawlRunning ? "waiting" : thisRun.sheetError ? "failed" : "waiting",
          detail: thisRun.sheetSynced ? "the Sheet now matches the database" : undefined,
        },
      ]
    : null;

  const needEnrich = shown
    ? await db.company.count({
        where: {
          industry: { equals: shown, mode: "insensitive" },
          primaryDomain: { not: null },
          contacts: { none: { email: { not: null } } },
        },
      })
    : 0;

  // Contact routes can live on a Claim with no Contact row — the export already
  // falls back to them, so the page must too or the two disagree.
  const claimFallback = new Map<string, { phone?: string; email?: string }>();
  if (results.length) {
    const claims = await db.claim.findMany({
      where: {
        companyId: { in: results.map((c) => c.id) },
        field: { in: ["company.phone", "company.email", "company.roleEmail"] },
      },
      orderBy: { observedAt: "desc" },
    });
    for (const cl of claims) {
      if (!cl.companyId) continue;
      const e = claimFallback.get(cl.companyId) ?? {};
      const v = typeof cl.value === "string" ? cl.value : String(cl.value);
      if (cl.field === "company.phone") e.phone ??= v;
      else e.email ??= v;
      claimFallback.set(cl.companyId, e);
    }
  }

  const routeOf = (c: (typeof results)[number]) => {
    const named = c.contacts.find((x) => x.jobTitle && x.jobTitle !== "General enquiries" && !x.email?.startsWith("unknown-"));
    const any = c.contacts.find((x) => x.email && !x.email.startsWith("unknown-")) ?? c.contacts.find((x) => x.phone);
    const f = claimFallback.get(c.id) ?? {};
    return {
      person: named?.fullName ?? "",
      title: named?.jobTitle ?? "",
      email: named?.email ?? any?.email ?? f.email ?? "",
      phone: named?.phone ?? any?.phone ?? c.contacts.find((x) => x.phone)?.phone ?? f.phone ?? "",
    };
  };

  // Drafts already written for this company, newest first.
  const drafts = companyId
    ? await db.message.findMany({
        where: { contact: { companyId }, direction: "OUTBOUND", status: "PENDING_APPROVAL" },
        orderBy: { createdAt: "desc" },
        take: 4,
      })
    : [];

  // Company mode: run the classifier when a company is selected.
  let linked: Awaited<ReturnType<typeof classifyAndLink>> | null = null;
  let subject: { id: string; name: string; domain: string | null } | null = null;
  if (companyId) {
    const c = await db.company.findUnique({ where: { id: companyId } });
    if (c) {
      subject = { id: c.id, name: c.name, domain: c.primaryDomain };
      linked = await classifyAndLink(business.id, c.id);
    }
  }

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Command post</p>
        <h1>Generator</h1>
        <p className="sub">
          Search an industry to get companies in it, or search a company to find out what it is and who to link
          it with. Everything found lands in the database and flows straight into the spreadsheet.
        </p>
      </div>

      <div className="stats" style={{ marginBottom: "1.5rem" }}>
        <div className="stat"><span className="v">{companyCount}</span><span className="l">Companies</span></div>
        <div className="stat"><span className="v">{emailCount}</span><span className="l">With email</span></div>
        <div className="stat"><span className="v">{leadCount}</span><span className="l">Supplier leads</span></div>
        <div className="stat"><span className="v">{pairingCount}</span><span className="l">Pairings</span></div>
      </div>

      {/* ---------------- the spreadsheet ---------------- */}
      <section className="card" style={{ marginBottom: "1.5rem", borderLeft: "3px solid var(--accent)" }}>
        <div className="play-top">
          <div>
            <h2 style={{ marginTop: 0, marginBottom: ".2rem" }}>The database</h2>
            <span className="muted">
              {business.sheetUrl
                ? business.sheetSyncedAt
                  ? `Last synced ${business.sheetSyncedAt.toISOString().slice(0, 16).replace("T", " ")}`
                  : "Connected, not yet synced"
                : "Live Google Sheet — not connected yet"}
            </span>
          </div>
          {business.sheetUrl && (
            <a className="btn" href={business.sheetUrl} target="_blank" rel="noopener noreferrer">
              Open Google Sheet ↗
            </a>
          )}
        </div>

        {sheeterror && (
          <div className="banner err" style={{ margin: ".9rem 0 0" }}>
            <b>Sheets error.</b>
            <span>{sheeterror}</span>
          </div>
        )}

        {business.sheetUrl ? (
          <div className="actions" style={{ marginTop: ".9rem" }}>
            <form action={syncSheet.bind(null, business.id)}>
              <button className="btn ghost" type="submit">Sync now</button>
            </form>
            <form action={disconnectSheet.bind(null, business.id)}>
              <button className="btn ghost" type="submit">Disconnect</button>
            </form>
            <a className="btn ghost" href="/api/export/xlsx">Download .xlsx instead</a>
            <span className="muted">
              Every search syncs automatically. The Sheet is a mirror — it is overwritten each time, so notes
              belong in the app.
            </span>
          </div>
        ) : !sheetsConfigured() ? (
          <>
            <p style={{ marginBottom: ".6rem" }}>
              Live sync needs a Google <b>service account</b> — a robot Google account the app signs in as. No
              consent screen, no expiring tokens, works unattended. About five minutes:
            </p>
            <ol className="phases">
              <li>
                <b>Create it</b>
                <div className="muted">
                  console.cloud.google.com → new project → APIs &amp; Services → Library → enable{" "}
                  <b>Google Sheets API</b>. Then Credentials → Create credentials → <b>Service account</b>.
                </div>
              </li>
              <li>
                <b>Get its key</b>
                <div className="muted">
                  Open the service account → Keys → Add key → Create new key → <b>JSON</b>. A file downloads.
                </div>
              </li>
              <li>
                <b>Put two values in <code>.env</code></b>
                <div className="muted">
                  <code>GOOGLE_SERVICE_ACCOUNT_EMAIL</code> = the <code>client_email</code> from that JSON.{" "}
                  <code>GOOGLE_PRIVATE_KEY</code> = the <code>private_key</code> from it, in double quotes,
                  keeping the literal <code>{"\\n"}</code> sequences exactly as they appear rather than
                  turning them into real line breaks.
                </div>
              </li>
              <li>
                <b>Restart the dev server</b>
                <div className="muted">Then come back here and connect or create a Sheet.</div>
              </li>
            </ol>
            <p className="muted" style={{ marginTop: ".8rem" }}>
              Until then, <a href="/api/export/xlsx">download the .xlsx</a> and import it.
            </p>
          </>
        ) : (
          <>
            <p style={{ marginBottom: ".8rem" }}>
              Signed in as <code>{serviceAccountEmail()}</code>.
            </p>

            <div className="note-inline">
              <b>Create the Sheet yourself and share it.</b> Service accounts have no Drive storage of their own,
              so they cannot create a file — and this way you own it and can see it in your own Drive.
            </div>

            <ol className="phases" style={{ marginBottom: "1rem" }}>
              <li>
                <b>New blank Sheet</b>
                <div className="muted">
                  Go to <a href="https://sheets.new" target="_blank" rel="noopener noreferrer">sheets.new</a> and
                  name it anything.
                </div>
              </li>
              <li>
                <b>Share it with the service account</b>
                <div className="muted">
                  Share → paste <code>{serviceAccountEmail()}</code> → role <b>Editor</b> (not Viewer) → untick
                  &ldquo;Notify people&rdquo; → Share.
                </div>
              </li>
              <li>
                <b>Paste the URL below</b>
                <div className="muted">Straight from the browser bar. The app fills in the three tabs.</div>
              </li>
            </ol>

            <form action={connectSheet.bind(null, business.id)} className="callform">
              <label>
                Sheet URL
                <input name="sheet" placeholder="https://docs.google.com/spreadsheets/d/..." required />
              </label>
              <button className="btn" type="submit">Connect and sync</button>
            </form>

            <details style={{ marginTop: "1rem" }}>
              <summary style={{ cursor: "pointer", fontSize: ".88rem", color: "var(--ink-faint)" }}>
                Or let the app try to create one
              </summary>
              <div className="actions" style={{ marginTop: ".6rem" }}>
                <form action={syncSheet.bind(null, business.id)}>
                  <button className="btn ghost" type="submit">Create a new Sheet</button>
                </form>
                <span className="muted">
                  Usually fails with 403 for a service account. Works if you are signed in via
                  <code> gcloud auth application-default login</code> instead.
                </span>
              </div>
            </details>
          </>
        )}
      </section>

      {notfound && (
        <div className="banner err">
          <b>Nothing found.</b>
          <span>
            No company matched that. Try the domain rather than the name — OpenStreetMap indexes local
            businesses by name, so anything without a shopfront is often missing.
          </span>
        </div>
      )}

      {hasApiKey() && !googleConfigured() && (
        <div className="banner">
          <b>Google search is not connected.</b>
          <span>
            Discovery works, but each search takes ~80 seconds because it reasons over web results. Real
            Google results come back in about a second and cover small operators far better. Google&apos;s own
            Custom Search API is closed to new signups, so use{" "}
            <a href="https://serper.dev" target="_blank" rel="noopener noreferrer">serper.dev</a> — 2,500 free
            credits, no card. Put the key in <code>.env</code> as <code>SERPER_API_KEY</code> and restart.
          </span>
        </div>
      )}

      {!hasApiKey() && (
        <div className="banner">
          <b>Running on OpenStreetMap only.</b>
          <span>
            Without <code>ANTHROPIC_API_KEY</code> discovery finds names, addresses and phones but few websites
            (6–14% by industry), and company classification is keyword matching rather than reading. Both still work.
          </span>
        </div>
      )}

      <div className="grid two" style={{ alignItems: "start" }}>
        {/* ---------------- mode 1: by industry ---------------- */}
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Search by industry</h2>
          <p className="muted" style={{ marginTop: "-.4rem" }}>
            Finds real companies in that trade and saves them with whatever contact route is published.
          </p>
          <form action={searchIndustry.bind(null, business.id)} className="callform">
            <label>
              Industry
              <input name="industry" placeholder="e.g. commercial laundry, pest control, dental clinic" required />
            </label>
            <div className="two-up">
              <label>
                How many <span className="muted">(up to 100)</span>
                <input name="limit" type="number" min={5} max={200} defaultValue={60} />
              </label>
              <label style={{ justifyContent: "flex-end" }}>
                <span className="muted" style={{ fontSize: ".8rem" }}>
                  <input type="checkbox" name="crawl" style={{ width: "auto", marginRight: ".4rem" }} />
                  Also crawl their websites (slower, richer)
                </span>
              </label>
            </div>
            <SearchButton className="btn" label="Find companies" pendingLabel="Searching Google…" />
          </form>

          <p className="muted" style={{ margin: "1rem 0 .4rem", fontSize: ".85rem" }}>From your pairing library:</p>
          <div className="actions">
            {suggested.slice(0, 8).map((ind) => (
              <form key={ind} action={searchIndustry.bind(null, business.id)}>
                <input type="hidden" name="industry" value={ind} />
                <input type="hidden" name="limit" value="60" />
                <button className="btn ghost" type="submit" style={{ fontSize: ".8rem" }}>
                  {ind.split(/[ ,]/).slice(0, 3).join(" ")}
                </button>
              </form>
            ))}
          </div>
        </section>

        {/* ---------------- mode 2: by company ---------------- */}
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Search by company</h2>
          <p className="muted" style={{ marginTop: "-.4rem" }}>
            Give a domain or a name. It works out what they do, which side of the market they sit on, and who
            they could be introduced to — in both directions.
          </p>
          <form action={searchCompany.bind(null, business.id)} className="callform">
            <label>
              Company
              <input name="company" placeholder="greencoolaircon.com — or a company name" required />
            </label>
            <button className="btn" type="submit">Identify and link</button>
          </form>

          {recentCompanies.length > 0 && (
            <>
              <p className="muted" style={{ margin: "1rem 0 .4rem", fontSize: ".85rem" }}>Recently found:</p>
              <div className="actions">
                {recentCompanies.slice(0, 6).map((c) => (
                  <Link key={c.id} className="btn ghost" href={`/generator?company=${c.id}`} style={{ fontSize: ".8rem" }}>
                    {c.name.slice(0, 26)}
                  </Link>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ---------------- who to pitch first ---------------- */}
      {shown && pitch.length > 0 && (
        <div className="panel" style={{ marginTop: "2.5rem" }}>
          <div className="lane-head" style={{ marginBottom: ".6rem" }}>
            <h2 style={{ margin: 0 }}>Leaking visitors</h2>
            <span className="muted" style={{ fontSize: ".8rem" }}>
              search position x conversion leaks
            </span>
          </div>
          <p className="muted" style={{ fontSize: ".84rem", marginTop: 0 }}>
            Companies people actually reach, whose site loses them anyway. The two multiply on purpose: a firm with
            no traffic has a website problem nobody pays for, and a firm converting well has nothing to fix.
            Position is a free proxy from Google results, not measured traffic.
          </p>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Company</th><th>Google</th><th>Reach</th><th>Leak</th><th>Pitch</th><th>What to open with</th></tr>
              </thead>
              <tbody>
                {pitch.map((t) => (
                  <tr key={t.companyId}>
                    <td><strong>{t.name}</strong></td>
                    <td className="muted" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      #{t.serpBestPosition} · {t.serpAppearances}x
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{t.reach}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{t.leak}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}><strong>{t.priority}</strong></td>
                    <td className="muted" style={{ fontSize: ".82rem", maxWidth: "26rem" }}>
                      {t.findings[0] ?? "nothing verified — the site renders in the browser"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------------- industry results ---------------- */}
      {shown && (
        <>
          <div className="lane-head" style={{ marginTop: "2.5rem" }}>
            <h2>{shown}</h2>
            <span className="muted">
              {found ?? results.length} found · {saved ?? 0} new · {results.length} in database
              {Number(nocontact ?? 0) > 0 && (
                // Said plainly rather than quietly dropped. A search that finds
                // sixty names and can contact four of them has told you
                // something about the industry, not about the search.
                <>
                  {" · "}
                  <span title="Found with no website and no phone — usually OpenStreetMap entries, which store a name and a location and nothing else.">
                    {nocontact} had no way to contact them
                  </span>
                </>
              )}
            </span>
          </div>

          {enriched && (
            <p className="notice" style={{ marginBottom: "1rem" }}>
              Opened {enriched} websites · found {emailsFound} emails and {phonesFound} phone numbers ·{" "}
              {remaining === "0" ? "every company here has been crawled." : `${remaining} still to crawl.`}
            </p>
          )}

          {progressStages && (
            <RunProgress stages={progressStages} active={stillWorking} />
          )}

          {needEnrich > 0 && !enriching && (
            <form action={enrichIndustry.bind(null, business.id)} className="panel" style={{ marginBottom: "1rem" }}>
              <input type="hidden" name="industry" value={shown} />
              <input type="hidden" name="batch" value="20" />
              <strong>{needEnrich} companies have a website but no email yet.</strong>
              <p className="muted" style={{ margin: "0.35rem 0 0.75rem", fontSize: "0.86rem" }}>
                Search returns what Google shows — a name, a domain, sometimes a phone. The inbox is on the
                company&rsquo;s own site and has to be fetched, at roughly ten seconds each. This opens the next 20.
              </p>
              <button type="submit">Fetch contact details for 20</button>
            </form>
          )}

          {planQueriesList.length > 0 && (
            <details className="panel" style={{ marginBottom: "1rem" }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                {planQueriesList.length} searches run{" "}
                <span className="muted" style={{ fontWeight: 400 }}>
                  · {plan?.source === "agent" ? "written by the query strategist" : "hardcoded fallback"}
                  {plan?.companiesFound ? ` · ${plan.companiesFound} companies to date` : ""}
                </span>
              </summary>
              <ul style={{ margin: "0.75rem 0 0", padding: 0, listStyle: "none", display: "grid", gap: "0.5rem" }}>
                {planQueriesList.map((q) => (
                  <li key={q.query} style={{ display: "grid", gridTemplateColumns: "9rem 1fr", gap: "0.75rem" }}>
                    <code className="muted" style={{ fontSize: "0.75rem" }}>{q.intent}</code>
                    <div>
                      <strong>{q.query}</strong>
                      <div className="muted" style={{ fontSize: "0.8rem" }}>{q.why}</div>
                    </div>
                  </li>
                ))}
              </ul>
              {plan?.rationale && (
                <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.75rem" }}>{plan.rationale}</p>
              )}
              <form action={replanIndustry.bind(null, business.id)} style={{ marginTop: "0.75rem" }}>
                <input type="hidden" name="industry" value={shown} />
                <button type="submit" className="ghost">Rewrite these searches</button>
              </form>
            </details>
          )}

          {results.length === 0 ? (
            <div className="empty">
              <h3>Nothing matched &ldquo;{shown}&rdquo;</h3>
              <p>
                OpenStreetMap indexes businesses by name and shop type. Trades with no shopfront — consultants,
                agencies, contractors — are often missing entirely. Try the trade as a customer would say it
                (&ldquo;chocolate shop&rdquo;, &ldquo;aircon servicing&rdquo;), or add an
                <code> ANTHROPIC_API_KEY</code> so web search runs too.
              </p>
            </div>
          ) : (
            <>
              <div className="stats" style={{ marginBottom: "1rem" }}>
                <div className="stat"><span className="v">{results.length}</span><span className="l">Companies</span></div>
                <div className="stat good"><span className="v">{results.filter((c) => routeOf(c).phone).length}</span><span className="l">With phone</span></div>
                <div className="stat"><span className="v">{results.filter((c) => routeOf(c).email).length}</span><span className="l">With email</span></div>
                <div className="stat"><span className="v">{results.filter((c) => c.websiteUrl).length}</span><span className="l">With website</span></div>
              </div>

              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Company</th><th>Phone</th><th>Email</th><th>Contact</th>
                      <th>Website</th><th>Address</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((c) => {
                      const r = routeOf(c);
                      return (
                        <tr key={c.id}>
                          <td><b>{c.name}</b></td>
                          <td className="mono">{r.phone || <span className="muted">—</span>}</td>
                          <td className="mono" style={{ wordBreak: "break-all" }}>{r.email || <span className="muted">—</span>}</td>
                          <td>{r.person ? `${r.person}${r.title ? `, ${r.title}` : ""}` : <span className="muted">—</span>}</td>
                          <td style={{ wordBreak: "break-all" }}>
                            {c.websiteUrl ? (
                              <a href={c.websiteUrl} target="_blank" rel="noopener noreferrer">{c.primaryDomain ?? "link"}</a>
                            ) : <span className="muted">—</span>}
                          </td>
                          <td className="muted">{c.addressLine ?? "—"}</td>
                          <td><Link href={`/generator?company=${c.id}`}>link it →</Link></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                All of this is in the database and the spreadsheet already. A blank contact column means nothing
                was published — never a guess.
              </p>
            </>
          )}
        </>
      )}

      {/* ---------------- company result ---------------- */}
      {subject && linked && (
        <>
          <div className="lane-head" style={{ marginTop: "2.5rem" }}>
            <h2>{subject.name}</h2>
            <span className="muted">{subject.domain ?? "no domain"}</span>
          </div>

          <div className="card" style={{ marginBottom: "1rem" }}>
            <dl>
              <dt>Identified as</dt>
              <dd className="why">{linked.classification.industry}</dd>
              <dt>What they sell</dt>
              <dd>{linked.classification.whatTheySell.slice(0, 320)}</dd>
              <dt>Side of the market</dt>
              <dd>{linked.classification.side}</dd>
              <dt>Confidence</dt>
              <dd>
                {Math.round(linked.classification.confidence * 100)}% —{" "}
                <span className="muted">{linked.classification.reasoning}</span>
              </dd>
            </dl>
          </div>

          {drafts.length > 0 && (
            <>
              <h2>Drafts</h2>
              <p className="muted" style={{ marginTop: "-.4rem" }}>
                Saved to the approval queue — review and send from <Link href="/outreach">Outreach</Link>, where
                every message still passes the compliance gate.
              </p>
              <div className="grid" style={{ marginBottom: "1.5rem" }}>
                {drafts.map((d) => (
                  <article key={d.id} className="card play">
                    <div className="play-top">
                      <div>
                        <h3>{d.subject}</h3>
                        <span className="motion">
                          {d.createdAt.toISOString().slice(0, 16).replace("T", " ")} · pending approval
                        </span>
                      </div>
                    </div>
                    <pre className="email">{d.bodyText}</pre>
                    {d.classifierNotes && (
                      <div className="note-inline" style={{ margin: 0 }}>
                        <b>Worth checking</b>
                        {d.classifierNotes}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </>
          )}

          {linked.suggestions.length === 0 ? (
            <div className="empty">
              <h3>No pairing matched</h3>
              <p>
                Nothing in the library covers this industry yet. Generate pairings for their sector on{" "}
                <Link href="/industry-pairings">Pairings</Link>, then try again.
              </p>
            </div>
          ) : (
            <>
              <p className="muted">
                {linked.suggestions.length} way{linked.suggestions.length === 1 ? "" : "s"} to link them:
              </p>
              <div className="grid">
                {linked.suggestions.map((s) => (
                  <article key={s.pairingId} className="card play">
                    <div className="play-top">
                      <div>
                        <h3>
                          {subject!.name} <span className="muted">→</span> {s.theirIndustry}
                        </h3>
                        <span className="motion">
                          They are side {s.ourSide} · {s.ourIndustry}
                          {s.commissionRate ? ` · ${s.commissionRate}% commission` : ""}
                        </span>
                      </div>
                      {s.dealLow && s.dealHigh && (
                        <span className="score-chip" style={{ fontSize: ".85rem" }}>
                          {money(s.dealLow)}–{money(s.dealHigh)}
                        </span>
                      )}
                    </div>
                    <dl>
                      <dt>What they offer</dt>
                      <dd>{s.whatWeOffer}</dd>
                      <dt>Why the other side needs it</dt>
                      <dd className="why">{s.whyTheyNeedIt}</dd>
                      <dt>Why now</dt>
                      <dd>{s.trigger}{s.timingWindow ? ` · ${s.timingWindow}` : ""}</dd>
                    </dl>

                    <div className="actions">
                      <form action={draftPair.bind(null, business.id, subject!.id, s.pairingId, s.ourSide)}>
                        <button className="btn" type="submit">
                          Draft both emails
                        </button>
                      </form>
                      <span className="muted">
                        One to {subject!.name} ({s.ourSide === "A" ? "asking to represent them" : "pitching them"}),
                        one to {s.theirIndustry.split(/[ ,]/).slice(0, 3).join(" ")}.
                      </span>
                    </div>

                    {s.knownCounterparts.length > 0 ? (
                      <dl>
                        <dt>Already in your database</dt>
                        <dd>
                          <ul className="notes">
                            {s.knownCounterparts.map((k) => (
                              <li key={k.id}>
                                <Link href={`/generator?company=${k.id}`}>{k.name}</Link>
                                <span className="muted">
                                  {k.email ? ` · ${k.email}` : ""}{k.phone ? ` · ${k.phone}` : ""}
                                  {!k.email && !k.phone ? " · no contact route" : ""}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </dd>
                      </dl>
                    ) : (
                      <form action={searchIndustry.bind(null, business.id)}>
                        <input type="hidden" name="industry" value={s.theirIndustry} />
                        <input type="hidden" name="limit" value="60" />
                        <button className="btn ghost" type="submit">
                          Find {s.theirIndustry.split(/[ ,]/).slice(0, 3).join(" ")} companies
                        </button>
                      </form>
                    )}
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* ---------------- recent runs ---------------- */}
      {runs.length > 0 && (
        <>
          <h2>Recent searches</h2>
          <div className="card">
            {runs.map((r) => (
              <div key={r.id} className="row">
                <div>
                  <b>{r.query}</b>
                  <div className="muted">
                    {r.startedAt.toISOString().slice(0, 16).replace("T", " ")} · {r.targetsAttempted} found ·{" "}
                    {r.companiesCreated} saved
                    {Array.isArray((r.log as { adapters?: unknown })?.adapters) && (
                      <>
                        {" · "}
                        {((r.log as { adapters: Array<{ adapter: string; found: number; error?: string; skipped?: string }> }).adapters)
                          .map((a) => `${a.adapter} ${a.error ? "failed" : a.skipped ? "not needed" : a.found}`)
                          .join(", ")}
                      </>
                    )}
                  </div>
                  {r.error && (
                    <div className="muted" style={{ color: "var(--crit)", fontSize: ".82rem", marginTop: ".2rem" }}>
                      {r.error}
                    </div>
                  )}
                </div>
                <span
                  className={`lane ${r.status === "done" ? "lane-TRIGGER" : r.status === "failed" ? "lane-CONTRARIAN" : "lane-SEASONAL"}`}
                  title={r.error ?? undefined}
                >
                  {r.status}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
