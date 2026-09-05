/**
 * Scrape the industries the pairings actually need.
 *
 *   npx tsx scripts/fill-pairings.ts --dry-run
 *   npx tsx scripts/fill-pairings.ts --top 5 --limit 60
 *
 * The audit found 67 of 112 pairings with companies on NEITHER side. The
 * pairing engine has been producing hypotheses faster than the generator
 * produces companies to test them against, and the two were never connected:
 * discovery ran on whatever industry somebody typed into the form, while a
 * queue of exactly what to scrape sat in the pairings table.
 *
 * This closes that loop. It reads the pairings, works out which industries are
 * missing or thin, and scrapes them worst-first.
 *
 * Costs real money on both sides — Serper credits per search page, and a model
 * call per industry for the query strategist. --dry-run prints the plan and
 * spends nothing.
 */
import { db } from "@/lib/db";
import { discoverIndustry } from "@/lib/discover-industry";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const top = Number(argv[argv.indexOf("--top") + 1]) || 5;
const limit = Number(argv[argv.indexOf("--limit") + 1]) || 60;

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

const pairings = await db.pairing.findMany({
  where: { businessId: biz.id, status: { in: ["active", "proposed"] } },
  select: { supplierIndustry: true, buyerIndustry: true, score: true },
});

const companies = await db.company.groupBy({ by: ["industry"], _count: { _all: true } });
const have = new Map(
  companies.filter((c) => c.industry).map((c) => [c.industry!.toLowerCase().trim(), c._count._all]),
);
const countFor = (industry: string) => {
  const k = industry.toLowerCase().trim();
  if (have.has(k)) return have.get(k)!;
  // A near match counts: "aircon servicing" covers "aircon servicing singapore".
  for (const [k2, n] of have) {
    if (k2.includes(k) || k.includes(k2)) return n;
  }
  return 0;
};

/**
 * How much scraping one industry unblocks.
 *
 * A pairing needs BOTH sides to be actionable, so an industry that is the
 * missing half of several pairings is worth more than one that is the missing
 * half of a single pairing — and an industry whose partner is also missing
 * unblocks nothing on its own.
 */
type Need = { industry: string; companies: number; unblocks: number; halfBlocked: number; score: number };
const needs = new Map<string, Need>();

for (const p of pairings) {
  for (const [side, other] of [
    [p.supplierIndustry, p.buyerIndustry],
    [p.buyerIndustry, p.supplierIndustry],
  ] as const) {
    const mine = countFor(side);
    if (mine >= limit) continue; // already covered
    const theirs = countFor(other);
    const n = needs.get(side) ?? { industry: side, companies: mine, unblocks: 0, halfBlocked: 0, score: 0 };
    // Scraping this side completes a pairing only if the other side exists.
    if (theirs > 0) n.unblocks += 1;
    else n.halfBlocked += 1;
    n.score += (theirs > 0 ? 3 : 1) * (p.score ?? 0.5);
    needs.set(side, n);
  }
}

const ranked = [...needs.values()].sort((a, b) => b.unblocks - a.unblocks || b.score - a.score);

const dead = pairings.filter((p) => countFor(p.supplierIndustry) === 0 && countFor(p.buyerIndustry) === 0).length;
console.log(`${pairings.length} pairings · ${dead} with companies on neither side`);
console.log(`${ranked.length} industries under the ${limit}-company mark\n`);
console.log(`${"industry".padEnd(46)} ${"have".padStart(5)} ${"completes".padStart(10)} ${"opens".padStart(6)}`);
for (const n of ranked.slice(0, 20)) {
  console.log(`${n.industry.slice(0, 46).padEnd(46)} ${String(n.companies).padStart(5)} ${String(n.unblocks).padStart(10)} ${String(n.halfBlocked).padStart(6)}`);
}

console.log(
  `\n"completes" = pairings where the other side already has companies, so scraping this one ` +
    `makes the pairing actionable. Those come first.`,
);

if (dryRun) {
  console.log(`\ndry run — would scrape the top ${top}: ${ranked.slice(0, top).map((n) => n.industry).join(", ")}`);
  await db.$disconnect();
  process.exit(0);
}

for (const n of ranked.slice(0, top)) {
  console.log(`\n--- ${n.industry} (have ${n.companies}, want ${limit}) ---`);
  try {
    const r = await discoverIndustry(biz.id, n.industry, { limit, crawl: true });
    console.log(`  found ${r.found} · created ${r.created} · crawled ${r.crawled} · already known ${r.skippedKnown}`);
  } catch (e) {
    console.log(`  failed: ${e instanceof Error ? e.message.slice(0, 140) : e}`);
  }
}

await db.$disconnect();
