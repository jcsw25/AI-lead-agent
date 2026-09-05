import { db } from "@/lib/db";

/**
 * How much of the database the pitch ranking can actually see.
 *
 * Reported alongside the ranking rather than left implicit, because a list of
 * eight targets means two different things depending on why the rest are
 * missing. If most companies simply have no search position yet, the list is
 * thin because the backfill has not run. If most are client-rendered, the list
 * is thin because nothing can be asserted about them and no amount of running
 * anything will change it.
 *
 * A ranking that does not say what it could not see invites the reader to treat
 * absence as a verdict.
 */
export type PitchCoverage = {
  total: number;
  audited: number;
  /** Have a recorded search position — the reach half. */
  withReach: number;
  /** Site renders in the browser, so no absence can be asserted. */
  unassertable: number;
  /** Audited, assertable, and no leaks found. Their site works. */
  clean: number;
  /** Have at least one leak recorded. */
  leaking: number;
  /** Both halves present — the only ones that can be ranked at all. */
  rankable: number;
};

export async function pitchCoverage(industry?: string): Promise<PitchCoverage> {
  const where = industry ? { industry: { contains: industry, mode: "insensitive" as const } } : {};

  const [total, audited, withReach, unassertable, leaking, rankable] = await Promise.all([
    db.company.count({ where }),
    db.company.count({ where: { ...where, siteAudit: { reachable: true } } }),
    db.company.count({ where: { ...where, serpBestPosition: { not: null } } }),
    db.company.count({ where: { ...where, siteAudit: { reachable: true, reliable: false } } }),
    db.company.count({ where: { ...where, siteAudit: { leakScore: { gt: 0 } } } }),
    db.company.count({
      where: { ...where, serpBestPosition: { not: null }, siteAudit: { reachable: true, reliable: true } },
    }),
  ]);

  const clean = await db.company.count({
    where: { ...where, siteAudit: { reachable: true, reliable: true, leakScore: 0 } },
  });

  return { total, audited, withReach, unassertable, clean, leaking, rankable };
}
