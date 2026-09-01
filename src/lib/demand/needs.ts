import type { NeedStatus } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Building the probe queue.
 *
 * Every pairing is a hypothesis: "companies in industry B probably buy from
 * industry A". Under the old model that hypothesis was pitched. Under this one
 * it is asked — so each buyer-side company becomes a SUSPECTED need, which is a
 * question worth putting to them and nothing more.
 *
 * The distinction is the whole point. SUSPECTED is an inference and may never
 * be quoted to a supplier. CONFIRMED means a human wrote back and said it, with
 * the message attached. A system that blurs those two is guessing while
 * sounding certain, which is exactly what 782 speculative introductions were.
 */

export type SeedResult = {
  created: number;
  skipped: number;
  byCategory: Record<string, number>;
};

/**
 * Turn every pairing into suspected needs on the buyer side.
 *
 * Only contactable, non-rejected companies: a need you cannot ask about is not
 * a probe candidate.
 */
export async function seedSuspectedNeeds(
  businessId: string,
  opts: { perPairing?: number } = {},
): Promise<SeedResult> {
  const perPairing = opts.perPairing ?? 40;
  const out: SeedResult = { created: 0, skipped: 0, byCategory: {} };

  const pairings = await db.pairing.findMany({
    where: { businessId, status: { in: ["active", "proposed"] } },
    orderBy: { score: "desc" },
  });

  for (const p of pairings) {
    const buyers = await db.company.findMany({
      where: {
        industry: { equals: p.buyerIndustry, mode: "insensitive" },
        contacts: { some: { email: { not: null } } },
        qualifications: { some: { businessId, status: { not: "REJECTED" } } },
      },
      select: { id: true, qualifications: { where: { businessId }, select: { score: true }, take: 1 } },
      take: perPairing * 2,
    });

    const ranked = buyers
      .sort((a, b) => (b.qualifications[0]?.score ?? 0) - (a.qualifications[0]?.score ?? 0))
      .slice(0, perPairing);

    for (const b of ranked) {
      try {
        const existing = await db.need.findUnique({
          where: { businessId_companyId_category: { businessId, companyId: b.id, category: p.supplierIndustry } },
          select: { id: true },
        });
        if (existing) {
          out.skipped++;
          continue;
        }
        await db.need.create({
          data: {
            businessId,
            companyId: b.id,
            category: p.supplierIndustry,
            status: "SUSPECTED",
            urgency: "SOMEDAY",
            // Low on purpose. This is an industry-level guess about a company
            // nobody has spoken to.
            confidence: Math.min(0.35, p.score * 0.4),
            notes: `Inferred from the pairing "${p.supplierIndustry} → ${p.buyerIndustry}". Nobody has been asked.`,
          },
        });
        out.created++;
        out.byCategory[p.supplierIndustry] = (out.byCategory[p.supplierIndustry] ?? 0) + 1;
      } catch {
        out.skipped++;
      }
    }
  }

  return out;
}

/** Needs worth asking about, best first. */
export async function probeQueue(businessId: string, opts: { status?: NeedStatus; limit?: number } = {}) {
  return db.need.findMany({
    where: { businessId, status: opts.status ?? "SUSPECTED" },
    orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
    take: opts.limit ?? 50,
    include: {
      company: {
        select: {
          id: true, name: true, industry: true, websiteUrl: true,
          contacts: { where: { email: { not: null } }, select: { email: true, fullName: true, jobTitle: true }, take: 1 },
          siteAudit: { select: { findings: true } },
          qualifications: { where: { businessId }, select: { score: true, grade: true }, take: 1 },
        },
      },
    },
  });
}

/** Counts by status, for the header. */
export async function needCounts(businessId: string) {
  const rows = await db.need.groupBy({ by: ["status"], where: { businessId }, _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
}
