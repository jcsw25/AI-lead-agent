import { anthropicSearchAdapter, queryVariants } from "../src/adapters/search";
import { db } from "../src/lib/db";

console.log("query variants for 'aircon servicing':");
for (const v of queryVariants("aircon servicing")) console.log("   ·", v);

const known = new Set(
  (await db.company.findMany({ select: { primaryDomain: true } }))
    .map(c => c.primaryDomain).filter((d): d is string => Boolean(d))
);
console.log(`\nalready in database: ${known.size} domains`);

const t0 = Date.now();
const r = await anthropicSearchAdapter.discover("aircon servicing", "Singapore", 24, { exclude: known });
const dupes = r.filter(x => known.has(new URL(x.website!).hostname.replace(/^www\./, "")));
console.log(`\n${((Date.now()-t0)/1000).toFixed(0)}s · ${r.length} returned · ${dupes.length} already-known slipped through`);
for (const c of r.slice(0, 14)) console.log(`   ${c.name.slice(0,30).padEnd(32)} ${(c.website??"-").slice(0,40)}`);
await db.$disconnect();
