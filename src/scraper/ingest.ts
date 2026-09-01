import { db } from "@/lib/db";
import { crawlCompanySite, scrapeQuality, type CompanyScrape } from "./crawl";
import { registrableDomain } from "@/lib/domain";
import { sendableEmails, isNonBusiness } from "@/lib/entity";

/**
 * Turns a scrape into database records.
 *
 * Every field written carries the URL it came from. Nothing is inferred, nothing
 * is guessed, and an email pattern is never constructed from a person's name —
 * see the note in extract.ts. Records land as Company + Contact + Claim, and a
 * SupplierLead when we are recruiting this company onto the supply side.
 */

export type IngestResult = {
  domain: string;
  companyId?: string;
  created: boolean;
  contactsCreated: number;
  /** Addresses found but not on this company's domain — kept as Claims only. */
  foreignEmails: string[];
  emails: number;
  phones: number;
  tier: string;
  score: number;
  skipped?: string;
};

export async function ingestDomain(
  businessId: string,
  input: string,
  opts: { pairingId?: string; asSupplierLead?: boolean; runId?: string; knownName?: string } = {},
): Promise<IngestResult> {
  const domain = registrableDomain(input);
  if (!domain) return { domain: input, created: false, contactsCreated: 0, foreignEmails: [], emails: 0, phones: 0, tier: "THIN", score: 0, skipped: "invalid domain" };

  const scrape = await crawlCompanySite(input);
  if (!scrape) return { domain, created: false, contactsCreated: 0, foreignEmails: [], emails: 0, phones: 0, tier: "THIN", score: 0, skipped: "crawl failed" };

  if (!scrape.pagesFetched.length) {
    return {
      domain, created: false, contactsCreated: 0, foreignEmails: [], emails: 0, phones: 0, tier: "THIN", score: 0,
      skipped: scrape.blockedBy ? `blocked by ${scrape.blockedBy}` : "site unreachable",
    };
  }

  const q = scrapeQuality(scrape);
  const business = await db.business.findUniqueOrThrow({ where: { id: businessId }, select: { regionId: true } });

  const existing = await db.company.findUnique({ where: { primaryDomain: domain } });
  const company = await db.company.upsert({
    where: { primaryDomain: domain },
    update: {
      // A name from the search result ("Airple", "Jetstyle Aircon Servicing")
      // beats a scraped page title, which is usually SEO copy.
      name: opts.knownName || scrape.legalName || scrape.name || existing?.name || domain,
      legalName: scrape.legalName ?? existing?.legalName,
      description: scrape.description ?? existing?.description,
      websiteUrl: scrape.websiteUrl,
      addressLine: scrape.addresses[0] ?? existing?.addressLine,
      lastResearchedAt: new Date(),
      researchVersion: { increment: 1 },
      verification: "VERIFIED",
    },
    create: {
      primaryDomain: domain,
      name: opts.knownName || scrape.legalName || scrape.name || domain,
      legalName: scrape.legalName,
      description: scrape.description,
      websiteUrl: scrape.websiteUrl,
      addressLine: scrape.addresses[0],
      regionId: business.regionId,
      verification: "VERIFIED",
      lastResearchedAt: new Date(),
    },
  });

  // ---- claims: one row per sourced fact ----
  // Store what the site measurably is, alongside what it says. This is the only
  // signal reliably available for an SME — most publish no news at all, but
  // every one of them has a homepage that can be inspected.
  if (scrape.audit) {
    const a = scrape.audit;
    const auditData = {
      reachable: a.reachable, httpsOk: a.httpsOk, mobileViewport: a.mobileViewport,
      hasContactForm: a.hasContactForm, hasEmailLink: a.hasEmailLink, hasPhoneLink: a.hasPhoneLink,
      hasStructured: a.hasStructured, jsRendered: a.jsRendered,
      pageBytes: a.pageBytes, loadMs: a.loadMs, titleLength: a.titleLength,
      copyrightYear: a.copyrightYear, socialCount: a.socialCount, pagesFetched: a.pagesFetched,
      score: a.score, findings: a.findings as object, checkedAt: new Date(),
    };
    await db.siteAudit.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id, ...auditData },
      update: auditData,
    });
  }

  const claims: Array<{ field: string; value: unknown; sourceUrl: string; confidence: number }> = [];
  for (const e of scrape.emails) claims.push({ field: e.isRoleBased ? "company.roleEmail" : "company.email", value: e.value, sourceUrl: e.sourceUrl, confidence: 0.95 });
  for (const p of scrape.phones) claims.push({ field: "company.phone", value: p.value, sourceUrl: p.sourceUrl, confidence: 0.9 });
  for (const a of scrape.addresses) claims.push({ field: "company.address", value: a, sourceUrl: scrape.pagesFetched[0], confidence: 0.8 });

  for (const c of claims) {
    const dup = await db.claim.findFirst({ where: { companyId: company.id, field: c.field, sourceUrl: c.sourceUrl } });
    if (dup) continue;
    await db.claim.create({
      data: {
        companyId: company.id,
        field: c.field,
        value: c.value as object,
        confidence: c.confidence,
        verification: "VERIFIED",
        sourceUrl: c.sourceUrl,
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 180 * 864e5),
        agentRunId: opts.runId,
      },
    });
  }

  // Registry identifier — the one field that resolves a company unambiguously.
  if (scrape.uen) {
    const dup = await db.companyIdentifier.findFirst({ where: { scheme: "UEN", value: scrape.uen } });
    if (!dup) {
      await db.companyIdentifier.create({
        data: { companyId: company.id, scheme: "UEN", value: scrape.uen, sourceUrl: scrape.pagesFetched[0] },
      });
    }
  }

  // ---- contacts ----
  let contactsCreated = 0;
  const foreignEmails: string[] = [];

  // Named people first — worth far more than a generic inbox.
  for (const person of scrape.people) {
    if (!person.fullName) continue;
    const email = person.email ?? null;
    const existingContact = await db.contact.findFirst({
      where: { companyId: company.id, fullName: person.fullName },
    });
    if (existingContact) continue;
    await db.contact.create({
      data: {
        companyId: company.id,
        fullName: person.fullName,
        jobTitle: person.jobTitle,
        email: email ?? `unknown-${person.fullName.toLowerCase().replace(/\s+/g, ".")}@${domain}`,
        phone: person.phone,
        sourceUrl: person.sourceUrl,
        sourceType: "company_website",
        isBusinessContactInfo: true,
        // No published address means no verified contact route, whatever the name is worth.
        verification: email ? "VERIFIED" : "UNVERIFIED",
      },
    });
    contactsCreated++;
  }

  // Then role-based inboxes as a fallback route.
  //
  // An address is only a send route if it plausibly belongs to THIS company.
  // Measured across 435 companies, 253 addresses sat on a different business
  // domain — `astonair@singnet.com.sg` attached to daikin.com.sg, and
  // `giovanni.catbagan@oom.com.sg` attached to newway.sg. Those are partners,
  // parent groups, or the web designer, and mailing them puts the wrong
  // company's name in front of a stranger. They stay as Claims (recorded
  // above, with provenance) but never become a Contact.
  const { sendable, rejected } = sendableEmails(scrape.emails, domain);
  for (const r of rejected) foreignEmails.push(`${r.email.value} — ${r.reason}`);

  for (const e of sendable) {
    const dup = await db.contact.findFirst({ where: { companyId: company.id, email: e.value } });
    if (dup) continue;
    await db.contact.create({
      data: {
        companyId: company.id,
        fullName: e.isRoleBased ? `${company.name} (${e.value.split("@")[0]})` : e.value.split("@")[0],
        jobTitle: e.isRoleBased ? "General enquiries" : null,
        department: e.isRoleBased ? e.value.split("@")[0].toUpperCase() : null,
        email: e.value,
        phone: scrape.phones[0]?.value,
        sourceUrl: e.sourceUrl,
        sourceType: "company_website",
        isBusinessContactInfo: true,
        verification: "VERIFIED",
      },
    });
    contactsCreated++;
  }

  // ---- supplier lead ----
  if (opts.asSupplierLead) {
    const best = scrape.emails.find((e) => !e.isRoleBased) ?? scrape.emails[0];
    await db.supplierLead.upsert({
      where: { businessId_companyId: { businessId, companyId: company.id } },
      update: {
        contactScore: q.score,
        contactTier: q.tier,
        bestEmail: best?.value,
        bestPhone: scrape.phones[0]?.value,
        hasNamedContact: scrape.people.some((p) => p.email),
        status: q.tier === "THIN" && !scrape.phones.length ? "UNREACHABLE" : "ENRICHED",
        scrapedAt: new Date(),
        scrapeNotes: { quality: q.reasons, pages: scrape.pagesFetched, jsRendered: scrape.jsRendered ?? false } as object,
      },
      create: {
        businessId,
        companyId: company.id,
        pairingId: opts.pairingId,
        source: "SCRAPE",
        status: q.tier === "THIN" && !scrape.phones.length ? "UNREACHABLE" : "ENRICHED",
        whatTheySell: scrape.description ?? scrape.corpus.slice(0, 300),
        contactScore: q.score,
        contactTier: q.tier,
        bestEmail: best?.value,
        bestPhone: scrape.phones[0]?.value,
        hasNamedContact: scrape.people.some((p) => p.email),
        scrapedAt: new Date(),
        scrapeNotes: { quality: q.reasons, pages: scrape.pagesFetched, jsRendered: scrape.jsRendered ?? false } as object,
      },
    });
  }

  return {
    domain,
    companyId: company.id,
    created: !existing,
    contactsCreated,
    foreignEmails,
    emails: scrape.emails.length,
    phones: scrape.phones.length,
    tier: q.tier,
    score: q.score,
  };
}

/** Sequential on purpose — the fetcher throttles per host, and politeness beats speed. */
export async function ingestMany(
  businessId: string,
  domains: string[],
  opts: { pairingId?: string; asSupplierLead?: boolean } = {},
): Promise<{ runId: string; results: IngestResult[] }> {
  const run = await db.scrapeRun.create({
    data: {
      businessId,
      pairingId: opts.pairingId,
      mode: "domains",
      query: domains.slice(0, 20).join(", "),
      targetsAttempted: domains.length,
    },
  });

  const results: IngestResult[] = [];
  for (const d of domains) {
    try {
      results.push(await ingestDomain(businessId, d, { ...opts, runId: run.id }));
    } catch (e) {
      results.push({
        domain: d, created: false, contactsCreated: 0, foreignEmails: [], emails: 0, phones: 0,
        tier: "THIN", score: 0, skipped: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await db.scrapeRun.update({
    where: { id: run.id },
    data: {
      status: "done",
      companiesCreated: results.filter((r) => r.created).length,
      contactsFound: results.reduce((s, r) => s + r.contactsCreated, 0),
      emailsFound: results.reduce((s, r) => s + r.emails, 0),
      phonesFound: results.reduce((s, r) => s + r.phones, 0),
      blockedByRobots: results.filter((r) => r.skipped?.includes("robots")).length,
      log: results as object,
      finishedAt: new Date(),
    },
  });

  return { runId: run.id, results };
}
