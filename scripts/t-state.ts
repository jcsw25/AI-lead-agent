import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const c = await db.company.groupBy({ by: ["industry"], _count: { _all: true }, orderBy: { _count: { id: "desc" } } });
console.log("companies by industry:");
for (const x of c.slice(0, 10)) console.log(`  ${String(x._count._all).padStart(4)}  ${x.industry ?? "(none)"}`);

const unqualified = await db.company.count({ where: { qualifications: { none: { businessId: biz.id } } } });
console.log(`\ncompanies never scored     ${unqualified}`);
console.log(`prospects                 ${await db.prospect.count({ where: { businessId: biz.id, stage: { notIn: ["DISQUALIFIED","SUPPRESSED","LOST"] } } })}`);
console.log(`introductions             ${await db.introduction.count({ where: { businessId: biz.id, status: { in: ["PROPOSED","APPROVED","A_AGREED","B_CONTACTED"] } } })}`);
console.log(`suppliers onboarded       ${await db.supplier.count({ where: { isActive: true } })}`);
console.log(`drafts awaiting review    ${await db.message.count({ where: { businessId: biz.id, status: "DRAFT" } })}`);
console.log(`sent to REAL companies    ${await db.message.count({ where: { businessId: biz.id, status: "SENT", contact: { company: { name: { not: { contains: "Self test" } } } } } })}`);
console.log(`replies captured          ${await db.message.count({ where: { direction: "INBOUND" } })}`);
await db.$disconnect();
