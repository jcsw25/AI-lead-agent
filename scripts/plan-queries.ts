/**
 * Show the search plan for one or more industries.
 *
 *   npx tsx scripts/plan-queries.ts "dental clinic" "corporate gifting"
 *   npx tsx scripts/plan-queries.ts --refresh "aircon servicing"
 *
 * Plans are cached in QueryPlan, so running this twice costs one model call.
 */
import { db } from "@/lib/db";
import { planQueries } from "@/agents/query-strategist";

const argv = process.argv.slice(2);
const refresh = argv.includes("--refresh");
const industries = argv.filter((a) => !a.startsWith("--"));

if (!industries.length) {
  console.error('Pass at least one industry, e.g. npx tsx scripts/plan-queries.ts "dental clinic"');
  process.exit(1);
}

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const region = (await db.region.findUniqueOrThrow({ where: { id: biz.regionId } })).name;

for (const industry of industries) {
  const t0 = Date.now();
  const plan = await planQueries(industry, region, { refresh, businessId: biz.id });
  console.log(`\n${"=".repeat(72)}\n${industry}  ·  ${plan.source}  ·  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`${"=".repeat(72)}`);
  for (const q of plan.queries) {
    console.log(`  ${q.intent.padEnd(15)} ${q.query}`);
    console.log(`  ${" ".repeat(15)} → ${q.why}`);
  }
  console.log(`\n  rationale: ${plan.rationale}`);
  console.log(`  negatives: ${plan.negatives.slice(0, 20).join(", ")}`);
}

await db.$disconnect();
