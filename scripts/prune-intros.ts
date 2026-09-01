/**
 * Remove introductions whose companies no longer qualify.
 *
 * Rebuilding only adds; a company rejected after the fact keeps whatever
 * introductions it was already in. Anything a human has acted on is left alone.
 */
import { db } from "@/lib/db";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const rejected = new Set(
  (await db.qualification.findMany({ where: { businessId: biz.id, status: "REJECTED" }, select: { companyId: true } }))
    .map((q) => q.companyId),
);

const intros = await db.introduction.findMany({
  // Every non-terminal status, not just PROPOSED. Onboarding a supplier moves
  // their introductions to A_AGREED, and one of those pointed at a company
  // rejected afterwards — invisible to a pruner that only looked at PROPOSED.
  where: { businessId: biz.id, status: { in: ["PROPOSED", "APPROVED", "A_CONTACTED", "A_AGREED", "B_CONTACTED"] } },
  select: { id: true, companyAId: true, companyBId: true, companyA: { select: { name: true } }, companyB: { select: { name: true } } },
});

const doomed = intros.filter((i) => rejected.has(i.companyAId) || rejected.has(i.companyBId));
console.log(`${doomed.length} of ${intros.length} proposed introductions involve a rejected company`);
for (const d of doomed.slice(0, 10)) console.log(`  ${d.companyA.name} -> ${d.companyB.name}`);

if (doomed.length) {
  await db.introduction.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
  console.log(`\nremoved ${doomed.length}`);
}
console.log(`${await db.introduction.count({ where: { businessId: biz.id } })} introductions remain`);
await db.$disconnect();
