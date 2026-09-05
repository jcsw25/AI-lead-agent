import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const ps = await db.pairing.findMany({ where: { businessId: biz.id }, select: { supplierIndustry: true, buyerIndustry: true } });
const has = (a: string, b: string) => ps.some((p) =>
  p.supplierIndustry.toLowerCase().includes(a.toLowerCase()) && p.buyerIndustry.toLowerCase().includes(b.toLowerCase()));
const checks: Array<[string,string,string]> = [
  ["aircon", "chocolate", "temperature-critical storage; a failure ruins stock"],
  ["laundry", "Food Catering", "table linen, chef whites, aprons - recurring contract"],
  ["laundry", "dental", "gowns, towels, uniforms - hygiene-regulated, recurring"],
  ["logistics", "florist", "fresh flower imports, cold chain, hard festival deadlines"],
  ["aircon", "commercial laundry", "industrial heat load in a laundry plant"],
  ["logistics", "chocolate", "temperature-controlled import of raw chocolate"],
];
for (const [a, b, why] of checks) {
  console.log(`  ${has(a,b) ? "exists    " : "MISSING   "} ${a} -> ${b}`);
  if (!has(a,b)) console.log(`             ${why}`);
}
await db.$disconnect();
