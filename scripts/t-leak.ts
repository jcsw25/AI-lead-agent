import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const ids = (await db.qualification.findMany({ where: { businessId: biz.id, status: "REJECTED" }, select: { companyId: true } })).map((r) => r.companyId);
const leaks = await db.introduction.findMany({
  where: { businessId: biz.id, OR: [{ companyAId: { in: ids } }, { companyBId: { in: ids } }] },
  include: { companyA: { select: { name: true, primaryDomain: true } }, companyB: { select: { name: true, primaryDomain: true } } },
});
for (const l of leaks) {
  console.log(`  status=${l.status}  ${l.companyA.name} (${l.companyA.primaryDomain}) -> ${l.companyB.name} (${l.companyB.primaryDomain})`);
}
await db.$disconnect();
