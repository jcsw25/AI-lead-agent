import { db } from "@/lib/db";
import { currentBusiness } from "@/lib/business";
import { hasApiKey } from "@/agents/runtime";
import { draftRecruitmentEmail, onboardSupplier, setLeadStatus } from "../pairings/actions";

export const dynamic = "force-dynamic";

const TIER_LANE: Record<string, string> = { CONTACTABLE: "TRIGGER", PARTIAL: "SEASONAL", THIN: "ADJACENT" };

export default async function LeadsPage() {
  const business = await currentBusiness();
  if (!business) return <p>Run <code>npm run db:seed</code> first.</p>;

  const [leads, runs] = await Promise.all([
    db.supplierLead.findMany({
      where: { businessId: business.id },
      include: {
        company: { include: { contacts: true } },
        pairing: true,
        messages: { where: { direction: "OUTBOUND" }, orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: [{ contactScore: "desc" }, { createdAt: "desc" }],
    }),
    db.scrapeRun.findMany({ where: { businessId: business.id }, orderBy: { startedAt: "desc" }, take: 5 }),
  ]);

  const contactable = leads.filter((l) => l.contactTier === "CONTACTABLE").length;
  const withEmail = leads.filter((l) => l.bestEmail).length;
  const withPhone = leads.filter((l) => l.bestPhone).length;
  const named = leads.filter((l) => l.hasNamedContact).length;

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Supplier leads · side A</p>
        <h1>The database</h1>
        <p className="sub">
          Every company scraped, what they sell, how to reach them, and which buyer segment we would introduce
          them to. Every field carries the page it came from — nothing here is guessed.
        </p>
      </div>

      <div className="stats" style={{ marginBottom: "1.5rem" }}>
        <div className="stat"><span className="v">{leads.length}</span><span className="l">Companies</span></div>
        <div className="stat good"><span className="v">{contactable}</span><span className="l">Contactable</span></div>
        <div className="stat"><span className="v">{withEmail}</span><span className="l">With email</span></div>
        <div className="stat"><span className="v">{withPhone}</span><span className="l">With phone</span></div>
        <div className="stat"><span className="v">{named}</span><span className="l">Named contact</span></div>
      </div>

      <div className="actions" style={{ marginBottom: "1.5rem" }}>
        <a className="btn" href="/api/export/leads">Export CSV for Sheets</a>
        {runs[0] && (
          <span className="muted">
            Last scrape: {runs[0].targetsAttempted} attempted, {runs[0].companiesCreated} new,
            {" "}{runs[0].emailsFound} emails, {runs[0].phonesFound} phones
            {runs[0].blockedByRobots ? `, ${runs[0].blockedByRobots} blocked by robots.txt` : ""}
          </span>
        )}
      </div>

      {leads.length === 0 ? (
        <div className="empty">
          <h3>Database is empty</h3>
          <p>Go to Pairings, pick a thesis, and paste supplier websites to scrape.</p>
          <a className="btn" href="/pairings">Open pairings</a>
        </div>
      ) : (
        <div className="grid">
          {leads.map((l) => {
            const namedContact = l.company.contacts.find((c) => c.jobTitle && c.jobTitle !== "General enquiries");
            const draft = l.messages[0];
            return (
              <article key={l.id} className="card play">
                <div className="play-top">
                  <div>
                    <h3>{l.company.name}</h3>
                    <span className="motion">
                      {l.company.primaryDomain} · {l.status}
                      {l.pairing ? ` · → ${l.pairing.buyerIndustry}` : " · no pairing"}
                    </span>
                  </div>
                  <span className={`lane lane-${TIER_LANE[l.contactTier] ?? "ADJACENT"}`}>
                    {l.contactScore} {l.contactTier}
                  </span>
                </div>

                <dl>
                  <dt>Contact routes</dt>
                  <dd className="mono">
                    {l.bestEmail ?? "no email"} · {l.bestPhone ?? "no phone"}
                    {namedContact ? ` · ${namedContact.fullName} (${namedContact.jobTitle})` : ""}
                  </dd>
                  {l.company.addressLine && (<><dt>Address</dt><dd>{l.company.addressLine}</dd></>)}
                  {Array.isArray(l.scrapeNotes) === false && l.scrapeNotes !== null && (
                    <>
                      <dt>Data quality</dt>
                      <dd className="muted">
                        {((l.scrapeNotes as { quality?: string[] }).quality ?? []).join("; ")}
                      </dd>
                    </>
                  )}
                </dl>

                {draft && (
                  <>
                    <p style={{ margin: 0 }}><b>Recruitment draft:</b> {draft.subject}</p>
                    <pre className="email">{draft.bodyText}</pre>
                  </>
                )}

                <div className="actions">
                  {l.pairing && !draft && l.bestEmail && (
                    <form action={draftRecruitmentEmail.bind(null, business.id, l.id)}>
                      <button className="btn" type="submit">Write recruitment email</button>
                    </form>
                  )}
                  {l.status !== "ONBOARDED" && (
                    <form action={onboardSupplier.bind(null, business.id, l.id)}>
                      <button className="btn ghost" type="submit">Onboard as supplier</button>
                    </form>
                  )}
                  {l.status !== "DECLINED" && (
                    <form action={setLeadStatus.bind(null, l.id, "DECLINED")}>
                      <button className="btn ghost" type="submit">Declined</button>
                    </form>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {!hasApiKey() && leads.length > 0 && (
        <div className="banner" style={{ marginTop: "1.5rem" }}>
          <b>Contact data is real; copy is not.</b>
          <span>
            Everything scraped above came from the live web with a source URL. Recruitment emails are templates
            until <code>ANTHROPIC_API_KEY</code> is set.
          </span>
        </div>
      )}
    </>
  );
}
