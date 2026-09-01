import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const pairings = await db.pairing.findMany({ where: { businessId: biz.id }, select: { supplierIndustry: true, buyerIndustry: true } });
const covered = new Set(pairings.flatMap((p) => [p.supplierIndustry.toLowerCase(), p.buyerIndustry.toLowerCase()]));
const has = (i: string) => covered.has(i.toLowerCase()) || [...covered].some((c) => c.includes(i.toLowerCase()) || i.toLowerCase().includes(c));
for (const i of ["Food Catering", "mooncake", "commercial printing"]) {
  console.log(`  ${has(i) ? "covered" : "NO PAIRING"}  ${i}`);
}
await db.$disconnect();
