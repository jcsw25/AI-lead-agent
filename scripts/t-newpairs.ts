import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const ps = await db.pairing.findMany({
  where: { businessId: biz.id, OR: [
    { supplierIndustry: { in: ["Food Catering", "commercial printing", "mooncake"], mode: "insensitive" } },
    { buyerIndustry: { in: ["Food Catering", "commercial printing", "mooncake"], mode: "insensitive" } },
  ] },
  orderBy: { score: "desc" }, take: 6,
});
for (const p of ps) {
  console.log(`\n  ${p.score.toFixed(2)}  ${p.lane}  ${p.supplierIndustry} → ${p.buyerIndustry}`);
  console.log(`        why now: ${p.trigger.slice(0, 150)}`);
  console.log(`        deal: SGD ${Number(p.typicalDealLow ?? 0)}–${Number(p.typicalDealHigh ?? 0)} · ${(Number(p.commissionRate ?? 0) * 100).toFixed(0)}%`);
}
await db.$disconnect();
