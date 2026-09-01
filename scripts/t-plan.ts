import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const B = { businessId: biz.id };
console.log(`companies            ${await db.company.count()}`);
console.log(`  with an email      ${await db.company.count({ where: { contacts: { some: { email: { not: null } } } } })}`);
console.log(`  with a phone       ${await db.company.count({ where: { contacts: { some: { phone: { not: null } } } } })}`);
console.log(`  websites audited   ${await db.siteAudit.count()}`);
console.log(`industries           ${(await db.company.groupBy({ by: ["industry"] })).length}`);
console.log(`qualified            ${await db.qualification.count({ where: { ...B, status: "QUALIFIED" } })}`);
console.log(`rejected             ${await db.qualification.count({ where: { ...B, status: "REJECTED" } })}`);
console.log(`pairings             ${await db.pairing.count({ where: B })}`);
console.log(`introductions        ${await db.introduction.count({ where: B })}`);
console.log(`needs                ${await db.need.count({ where: B })}`);
console.log(`matchmakes           ${await db.matchmake.count({ where: B })}`);
const spend = await db.agentRun.aggregate({ where: B, _sum: { costUsd: true }, _count: { _all: true } });
console.log(`\nmodel runs           ${spend._count._all}`);
console.log(`total model spend    $${Number(spend._sum.costUsd ?? 0).toFixed(2)}`);
const searches = await db.scrapeRun.count({ where: { ...B, mode: "search" } });
console.log(`searches run         ${searches}`);
console.log(`cost per company     $${(Number(spend._sum.costUsd ?? 0) / (await db.company.count())).toFixed(4)}`);
// commission ceiling
const intros = await db.introduction.findMany({ where: B, select: { estimatedCommission: true } });
console.log(`\ncommission ceiling   $${intros.reduce((s,i)=>s+Number(i.estimatedCommission ?? 0),0).toLocaleString()}`);
// model table count
const models = Object.keys(db).filter((k) => !k.startsWith("$") && !k.startsWith("_"));
console.log(`\nprisma models        ${models.length}`);
await db.$disconnect();
