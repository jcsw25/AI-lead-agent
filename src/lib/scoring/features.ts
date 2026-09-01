import { db } from "@/lib/db";
import { isNonBusiness, isDirectorySite } from "@/lib/entity";
import { AGGREGATORS } from "@/adapters/search";

/**
 * Feature extraction.
 *
 * ADR-002: the model never assigns a score. It may extract features, but the
 * number is arithmetic over those features, computed here. Everything in this
 * file is derived from rows already in the database — no model call, no network,
 * fully reproducible, and re-runnable for free when the weights change.
 *
 * Each feature is normalised to 0..1 so weights are comparable, and each one
 * carries the evidence that produced it. A score you cannot explain line by
 * line is a score nobody will act on.
 */

export type Feature = {
  key: string;
  /** 0..1 */
  value: number;
  /** What the value was derived from — shown in the UI, quotable in review. */
  evidence: string;
};

export type CompanyFeatures = {
  companyId: string;
  name: string;
  industry: string | null;
  domain: string | null;
  features: Feature[];
  /** Facts the qualifier needs that are not scored: hard gates. */
  gates: {
    hasContactRoute: boolean;
    reachable: boolean;
    blockedByRobots: boolean;
    hasPairingThesis: boolean;
    looksLikeAggregator: boolean;
    /** Regulator, association, government body — set to the reason, or null. */
    nonBusiness: string | null;
    /** A site that lists other businesses rather than being one. */
    directorySite: string | null;
  };
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Domains that are marketplaces or directories rather than operating companies. */
const AGGREGATOR_HINT = /(directory|listing|marketplace|compare|reviews?|yellowpages|classified)/i;

export async function extractFeatures(businessId: string, companyIds?: string[]): Promise<CompanyFeatures[]> {
  const companies = await db.company.findMany({
    where: companyIds ? { id: { in: companyIds } } : {},
    select: {
      id: true, name: true, industry: true, primaryDomain: true, addressLine: true,
      description: true, verification: true, lastResearchedAt: true,
      contacts: { select: { email: true, phone: true, fullName: true, jobTitle: true, verification: true } },
      claims: { select: { field: true, observedAt: true, confidence: true, sourceUrl: true } },
      siteAudit: true,
    },
  });

  // Which industries the pairing library can actually build an A->B thesis for.
  const pairings = await db.pairing.findMany({
    where: { businessId },
    select: { supplierIndustry: true, buyerIndustry: true },
  });
  const paired = new Set(pairings.flatMap((p) => [p.supplierIndustry.toLowerCase(), p.buyerIndustry.toLowerCase()]));
  const hasThesis = (industry: string | null) => {
    if (!industry) return false;
    const i = industry.toLowerCase();
    return paired.has(i) || [...paired].some((p) => p.includes(i) || i.includes(p));
  };

  const now = Date.now();

  return companies.map((c) => {
    const emails = c.contacts.filter((x) => x.email);
    const phones = c.contacts.filter((x) => x.phone);
    const named = c.contacts.filter((x) => x.jobTitle && x.jobTitle !== "General enquiries");
    const audit = c.siteAudit;

    const features: Feature[] = [];

    // ---- contactability: can we reach them at all, and how well ----------
    // Weighted so that a role inbox plus a phone is nearly full marks, and a
    // named person is a bonus on top.
    //
    // The obvious split — named contact worth the most — was measured and
    // rejected: across 435 real Singapore companies, exactly zero publish named
    // staff. Reserving the largest share for something that never occurs locked
    // 13 points away from every company, capped the whole database at 63, and
    // produced no A or B grades at all. Scoring against a market that does not
    // exist tells you nothing about the market that does.
    let contactability = 0;
    const contactBits: string[] = [];
    if (emails.length) { contactability += 0.5; contactBits.push(`${emails.length} email`); }
    if (phones.length) { contactability += 0.3; contactBits.push(`${phones.length} phone`); }
    if (named.length) { contactability += 0.2; contactBits.push(`${named.length} named contact`); }
    features.push({
      key: "contactability",
      value: clamp01(contactability),
      evidence: contactBits.length ? contactBits.join(", ") : "no contact route found",
    });

    // ---- site quality: measured, not judged -----------------------------
    features.push({
      key: "siteQuality",
      value: audit ? clamp01(audit.score / 100) : 0,
      evidence: audit
        ? `site audit ${audit.score}/100${audit.reachable ? "" : " (unreachable)"}`
        : "site never audited",
    });

    // ---- opportunity: a WEAK site is the thing we can sell against -------
    // Deliberately inverted. A company with no enquiry form and a 2019 footer
    // is a better prospect for a web or automation supplier than one with a
    // polished site, and the weakness is the opening line of the email.
    const weaknesses = (audit?.findings as string[] | null) ?? [];
    const fixable = audit?.reachable ? weaknesses.length : 0;
    features.push({
      key: "improvableSite",
      value: clamp01(fixable / 5),
      evidence: fixable
        ? `${fixable} fixable weakness: ${weaknesses.slice(0, 2).join("; ")}`
        : audit?.reachable
          ? "site has no obvious weaknesses to lead with"
          : "site not reachable, nothing measured",
    });

    // ---- fit: does the pairing library know what to do with them ---------
    const thesis = hasThesis(c.industry);
    features.push({
      key: "pairingFit",
      value: thesis ? 1 : 0,
      evidence: thesis
        ? `"${c.industry}" has an A→B thesis in the pairing library`
        : `no pairing covers "${c.industry ?? "unclassified"}"`,
    });

    // ---- evidence depth: how much we actually know -----------------------
    const claimFields = new Set(c.claims.map((x) => x.field));
    features.push({
      key: "evidenceDepth",
      value: clamp01(claimFields.size / 4),
      evidence: `${c.claims.length} sourced claims across ${claimFields.size} fields`,
    });

    // ---- freshness: how stale is what we know ----------------------------
    const newest = c.claims.reduce<number>((m, x) => Math.max(m, x.observedAt?.getTime() ?? 0), 0);
    const ageDays = newest ? (now - newest) / 86_400_000 : 999;
    features.push({
      key: "freshness",
      value: clamp01(1 - ageDays / 180),
      evidence: newest ? `newest evidence ${Math.round(ageDays)} days old` : "no dated evidence",
    });

    // ---- verification: did the company itself tell us, or did we infer ----
    features.push({
      key: "verified",
      value: c.verification === "VERIFIED" ? 1 : c.verification === "INFERRED" ? 0.4 : 0,
      evidence: `${c.verification.toLowerCase()} — ${c.verification === "VERIFIED" ? "read from their own site" : "from a search result, not confirmed"}`,
    });

    return {
      companyId: c.id,
      name: c.name,
      industry: c.industry,
      domain: c.primaryDomain,
      features,
      gates: {
        hasContactRoute: emails.length > 0 || phones.length > 0,
        reachable: audit ? audit.reachable : Boolean(c.primaryDomain),
        blockedByRobots: Boolean(audit && !audit.reachable && ((audit.findings as string[] | null) ?? []).some((f) => f.includes("robots"))),
        hasPairingThesis: thesis,
        // The blocklist stops these at discovery, but rows saved before a
        // domain was added to it are still sitting in the database — so it is
        // applied here too rather than only at the point of capture.
        looksLikeAggregator:
          AGGREGATORS.has(c.primaryDomain ?? "") ||
          AGGREGATOR_HINT.test(c.primaryDomain ?? "") ||
          AGGREGATOR_HINT.test(c.name),
        nonBusiness: isNonBusiness(c.primaryDomain, c.name) || null,
        directorySite: isDirectorySite(c.description) || null,
      },
    };
  });
}
