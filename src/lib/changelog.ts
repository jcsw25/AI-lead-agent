import type { ChangeArea } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Recording what changed, and what it was before.
 *
 * Written by the code that makes the change rather than kept by hand. A
 * hand-maintained list drifts from the code within a week and then misleads
 * with confidence — which has already happened on this project, twice.
 *
 * `before` and `after` are both required, deliberately. "Improved the scoring"
 * is not a change description. "Rejected 14 aggregators, now rejects 33" is,
 * because it can be checked.
 */

export type ChangeEntry = {
  area: ChangeArea;
  title: string;
  before: string;
  after: string;
  why: string;
  impact?: string;
};

export async function logChange(businessId: string | null, entry: ChangeEntry) {
  return db.changeLog.create({ data: { businessId, ...entry } });
}

export async function logChanges(businessId: string | null, entries: ChangeEntry[]) {
  for (const e of entries) await logChange(businessId, e);
  return entries.length;
}

export async function recentChanges(businessId: string, limit = 40) {
  return db.changeLog.findMany({
    where: { OR: [{ businessId }, { businessId: null }] },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
