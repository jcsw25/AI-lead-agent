import { db } from "@/lib/db";
import { isDirectorySite } from "@/lib/entity";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

// 1. are directories detected and rejected?
const withDesc = await db.company.findMany({
  where: { description: { not: null } },
  select: { id: true, name: true, primaryDomain: true, description: true,
    qualifications: { where: { businessId: biz.id }, select: { status: true, rejectionReason: true } } },
});
const dirs = withDesc.filter((c) => isDirectorySite(c.description));
const notRejected = dirs.filter((c) => c.qualifications[0]?.status !== "REJECTED");
console.log(`directories detected            ${dirs.length}`);
console.log(`  ...NOT rejected (should be 0) ${notRejected.length}`);
for (const c of notRejected) console.log(`     LEAK: ${c.primaryDomain} — ${c.qualifications[0]?.status ?? "unqualified"}`);

// 2. does rejection propagate to prospects, drafts and introductions?
const rejected = await db.qualification.findMany({
  where: { businessId: biz.id, status: "REJECTED" }, select: { companyId: true },
});
const ids = rejected.map((r) => r.companyId);
const liveProspects = await db.prospect.count({
  where: { businessId: biz.id, companyId: { in: ids }, stage: { notIn: ["DISQUALIFIED", "SUPPRESSED", "LOST"] } },
});
const liveDrafts = await db.message.count({
  where: { businessId: biz.id, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"] },
    contact: { companyId: { in: ids } } },
});
const liveIntros = await db.introduction.count({
  where: {
    businessId: biz.id,
    // DISCARDED/LOST/WON are history, not open work.
    status: { in: ["PROPOSED", "APPROVED", "A_CONTACTED", "A_AGREED", "B_CONTACTED"] },
    OR: [{ companyAId: { in: ids } }, { companyBId: { in: ids } }],
  },
});
console.log(`\nrejected companies              ${ids.length}`);
console.log(`  still active prospects        ${liveProspects}  (should be 0)`);
console.log(`  still-open drafts to them     ${liveDrafts}  (should be 0)`);
console.log(`  still in introductions        ${liveIntros}  (should be 0)`);

await db.$disconnect();
