import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const ps = await db.pairing.findMany({
  where: { businessId: biz.id, supplierIndustry: { in: ["aircon servicing","commercial printing","HVAC","dental clinic","florist","Commercial laundry and linen services","logistics and freight forwarding","mooncake"], mode: "insensitive" } },
  orderBy: { updatedAt: "desc" }, take: 8,
});
for (const p of ps) {
  const deal = `SGD ${Number(p.typicalDealLow ?? 0)}-${Number(p.typicalDealHigh ?? 0)} @ ${(Number(p.commissionRate ?? 0)*100).toFixed(0)}%`;
  console.log(`\n${p.score.toFixed(2)} ${p.lane}  ${p.supplierIndustry} -> ${p.buyerIndustry}   [${deal}]`);
  console.log(`   A has:  ${p.whatAHas.slice(0, 130)}`);
  console.log(`   B needs:${p.whatBNeeds.slice(0, 130)}`);
  console.log(`   why now:${p.trigger.slice(0, 160)}`);
}
await db.$disconnect();
