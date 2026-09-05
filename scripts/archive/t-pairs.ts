import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const ps = await db.pairing.findMany({ where: { businessId: biz.id }, orderBy: { score: "desc" } });
const both = ps.filter((p) => (p.evidence as { bothSidesPresent?: boolean } | null)?.bothSidesPresent);
console.log(`${ps.length} pairings · ${both.length} with companies on both sides\n`);
console.log("strongest, both sides in the database:");
for (const p of both.slice(0, 12)) {
  console.log(`  ${p.score.toFixed(2)} ${p.lane.padEnd(11)} ${p.supplierIndustry.slice(0,26).padEnd(28)} -> ${p.buyerIndustry.slice(0,30)}`);
}
const inds = await db.company.groupBy({ by: ["industry"], _count: { _all: true }, orderBy: { _count: { id: "desc" } } });
console.log(`\nindustries actually held:`);
for (const i of inds.slice(0, 12)) console.log(`  ${String(i._count._all).padStart(4)}  ${i.industry ?? "(none)"}`);
await db.$disconnect();
