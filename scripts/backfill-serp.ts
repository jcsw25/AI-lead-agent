/**
 * Record where companies already stored actually rank.
 *
 *   npx tsx scripts/backfill-serp.ts --industry aircon --pages 3
 *   npx tsx scripts/backfill-serp.ts --all
 *
 * Search position is captured during discovery now, but every company already
 * in the database was found before that existed — so the traffic half of the
 * pitch ranking reads zero for all 1,152 of them.
 *
 * This runs the industry's head queries and records the position of any domain
 * we already hold. It creates nothing: a company that appears here and is not
 * in the database is ignored, because this is about ranking what we have, not
 * finding more.
 *
 * Costs Serper credits: about 40 per industry at the default depth. Measured on
 * aircon — 4 phrasings x 10 pages found 77 of 151 companies somewhere in the
 * first 100 results, against 23 at the old 3-page depth.
 *
 * The other 74 never appeared at all, and that is a finding rather than a gap:
 * a company absent from 100 results across four phrasings of its own trade has
 * no organic search traffic to lose, so the leak thesis does not apply to it.
 */
import { db } from "@/lib/db";
import { heuristicVariants } from "@/agents/query-strategist";
import { registrableDomain } from "@/lib/domain";

const argv = process.argv.slice(2);
const arg = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const pages = Number(arg("--pages")) || 10;
const only = arg("--industry");
const all = argv.includes("--all");

const key = process.env.SERPER_API_KEY;
if (!key) throw new Error("SERPER_API_KEY is not set.");

const industries = (
  await db.company.groupBy({ by: ["industry"], _count: { _all: true } })
)
  .filter((i) => i.industry && (all || (only && i.industry.toLowerCase().includes(only.toLowerCase()))))
  .sort((a, b) => b._count._all - a._count._all);

if (!industries.length) {
  console.log(`No industries matched. Pass --industry <name> or --all.`);
  process.exit(0);
}

console.log(`${industries.length} industries · ${pages} pages each\n`);
let credits = 0;
let updated = 0;

for (const ind of industries) {
  const industry = ind.industry!;
  // The domains we hold for this trade. Anything else in the results is a
  // company we do not have, and finding those is discovery's job, not this.
  const known = new Map(
    (
      await db.company.findMany({
        where: { industry, primaryDomain: { not: null } },
        select: { id: true, primaryDomain: true },
      })
    ).map((c) => [c.primaryDomain!, c.id]),
  );
  if (!known.size) continue;

  const best = new Map<string, { position: number; appearances: number }>();

  for (const variant of heuristicVariants(industry).slice(0, 4)) {
    for (let page = 1; page <= pages; page++) {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q: `${variant} Singapore`, gl: "sg", page }),
        signal: AbortSignal.timeout(30_000),
      });
      credits++;
      if (!res.ok) break;
      const json = (await res.json()) as {
        organic?: Array<{ link: string; position?: number }>;
      };
      for (const it of json.organic ?? []) {
        const d = registrableDomain(it.link);
        if (!d || !known.has(d)) continue;
        // Position within the page, offset by the page number — Serper restarts
        // its numbering on every page, so page 2 position 3 is really 13th.
        const absolute = (it.position ?? 10) + (page - 1) * 10;
        const prior = best.get(d);
        best.set(d, {
          position: prior ? Math.min(prior.position, absolute) : absolute,
          appearances: (prior?.appearances ?? 0) + 1,
        });
      }
    }
  }

  for (const [domain, v] of best) {
    await db.company.update({
      where: { id: known.get(domain)! },
      data: { serpBestPosition: v.position, serpAppearances: v.appearances },
    });
    updated++;
  }

  console.log(
    `${industry.slice(0, 34).padEnd(36)} ${String(known.size).padStart(4)} held · ${String(best.size).padStart(3)} ranked`,
  );
}

console.log(`\n${updated} companies given a search position · ${credits} Serper credits used`);
await db.$disconnect();
