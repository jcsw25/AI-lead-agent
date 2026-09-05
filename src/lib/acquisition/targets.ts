import type { AcquisitionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { nameFromDomain } from "@/lib/entity";

/**
 * The proprietary lane: companies nobody has advertised.
 *
 * This is the half of the pipeline that is actually worth having. Everything on
 * businessforsale.sg is being looked at by everyone else on
 * businessforsale.sg — the listing is the competition. A company that has never
 * been marketed has no competing bidder, no broker fee, and an owner who has
 * not yet decided what the business is worth.
 *
 * The cost is that most of them are not for sale, so the ask has to be light
 * enough that a no costs nothing on either side. That constraint lives in the
 * enquiry writer; what lives here is who is worth asking.
 *
 * Note what is NOT scored: nothing here estimates what a company is worth, and
 * nothing ranks by a guess at its earnings. We do not have their numbers. What
 * we have is evidence the business is real and operating, and that is all this
 * ranking claims.
 */

export type SeedResult = {
  created: number;
  skipped: number;
  considered: number;
  byIndustry: Record<string, number>;
};

/**
 * Signs a company is a going concern worth an approach.
 *
 * Deliberately crude, and every input is observed rather than inferred. The
 * alternative — ranking by estimated revenue — would be a number we invented
 * about a company we have never spoken to, put in front of a decision to spend
 * money.
 */
function operatingScore(c: {
  siteAudit: { reachable: boolean; score: number; copyrightYear: number | null } | null;
  contacts: unknown[];
  employeeCount: number | null;
  foundedYear: number | null;
}): { score: number; why: string[] } {
  const why: string[] = [];
  let score = 0;
  const thisYear = new Date().getFullYear();

  if (c.siteAudit?.reachable) {
    score += 2;
    // A site kept current is the cheapest evidence that somebody is still
    // running the business.
    if (c.siteAudit.copyrightYear && c.siteAudit.copyrightYear >= thisYear - 1) {
      score += 2;
      why.push("site kept up to date");
    } else if (c.siteAudit.copyrightYear && c.siteAudit.copyrightYear <= thisYear - 4) {
      // Not a disqualifier. An owner who stopped maintaining the website years
      // ago is sometimes exactly the owner who is ready to stop entirely.
      score += 1;
      why.push(`site last touched ${c.siteAudit.copyrightYear} — possibly winding down`);
    }
  }

  if (c.contacts.length) {
    score += 2;
    why.push("published a way to reach them");
  }

  if (c.employeeCount && c.employeeCount >= 3) {
    score += 2;
    why.push(`${c.employeeCount} staff — a business, not one person`);
  }

  if (c.foundedYear && thisYear - c.foundedYear >= 8) {
    score += 2;
    why.push(`operating ${thisYear - c.foundedYear} years`);
  }

  return { score, why };
}

/**
 * A name you could put in front of somebody, or null.
 *
 * Some company rows carry a scraped page title rather than a name — searching
 * "aircon" produced three targets called "Aircon Servicing Singapore", which is
 * an SEO heading every firm in the trade uses. On the sales side that is
 * cosmetic, because the name never appears in the email. Here the list IS the
 * product: a shortlist of businesses to buy, five of them identically named,
 * cannot be worked through by a person.
 *
 * The domain is the better source when the title is generic — it is what the
 * owner registered.
 */
function usableName(name: string, domain: string | null, industry: string): string | null {
  const flat = (s: string) =>
    s.toLowerCase().replace(/\b(pte|ltd|llp|singapore|sg|the|and|co)\b/g, "").replace(/[^a-z0-9]/g, "");
  const n = flat(name);
  const ind = flat(industry);

  const generic = n.length > 0 && ind.length > 0 && (n === ind || n.includes(ind) || ind.includes(n));
  if (!generic) return name;
  if (!domain) return null;

  const derived = nameFromDomain(domain);
  return flat(derived) === ind ? null : derived;
}

/**
 * Turn companies in an industry into acquisition targets.
 *
 * Only companies with a contact route: a target you cannot ask is not a target,
 * it is a row.
 */
export async function seedProprietaryTargets(
  businessId: string,
  industry: string,
  opts: { limit?: number } = {},
): Promise<SeedResult> {
  const limit = opts.limit ?? 40;
  const out: SeedResult = { created: 0, skipped: 0, considered: 0, byIndustry: {} };

  const companies = await db.company.findMany({
    where: {
      industry: { contains: industry, mode: "insensitive" },
      contacts: { some: { email: { not: null } } },
    },
    select: {
      id: true, name: true, industry: true, websiteUrl: true, primaryDomain: true,
      employeeCount: true, foundedYear: true,
      contacts: { where: { email: { not: null } }, select: { id: true }, take: 1 },
      siteAudit: { select: { reachable: true, score: true, copyrightYear: true } },
    },
    take: limit * 4,
  });
  out.considered = companies.length;

  const ranked = companies
    .map((c) => ({ c, ...operatingScore(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  for (const r of ranked) {
    const existing = await db.acquisitionTarget.findFirst({
      where: { businessId, companyId: r.c.id },
      select: { id: true },
    });
    if (existing) {
      out.skipped++;
      continue;
    }
    const name = usableName(r.c.name, r.c.primaryDomain, industry);
    if (!name) {
      out.skipped++;
      continue;
    }
    await db.acquisitionTarget.create({
      data: {
        businessId,
        companyId: r.c.id,
        origin: "PROPRIETARY",
        status: "IDENTIFIED",
        name,
        industry: r.c.industry ?? industry,
        websiteUrl: r.c.websiteUrl,
        employeeCount: r.c.employeeCount,
        yearsEstablished: r.c.foundedYear,
        notes:
          `Not advertised for sale. Worth asking because: ${r.why.join("; ") || "it is an operating business in the industry"}. ` +
          `No financials — nothing here estimates what it earns.`,
      },
    });
    out.created++;
    const k = r.c.industry ?? industry;
    out.byIndustry[k] = (out.byIndustry[k] ?? 0) + 1;
  }

  return out;
}

/** Counts by status, for the header. */
export async function targetCounts(businessId: string) {
  const rows = await db.acquisitionTarget.groupBy({
    by: ["status"],
    where: { businessId },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
}

/** Targets at a status, best first. */
export async function targetQueue(
  businessId: string,
  opts: { status?: AcquisitionStatus; origin?: "LISTED" | "PROPRIETARY"; limit?: number } = {},
) {
  return db.acquisitionTarget.findMany({
    where: {
      businessId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    orderBy: [{ status: "asc" }, { askingMultiple: "asc" }, { createdAt: "desc" }],
    take: opts.limit ?? 60,
    include: {
      company: {
        select: {
          name: true, websiteUrl: true,
          contacts: { where: { email: { not: null } }, select: { email: true, fullName: true }, take: 1 },
        },
      },
    },
  });
}
