/**
 * Re-audit stored sites for conversion leaks.
 *
 *   npx tsx scripts/backfill-leaks.ts --limit 40 --industry aircon
 *
 * The leak signals are computed from HTML, and HTML is not kept — so applying
 * them to companies already stored means fetching each homepage again. One
 * request per company, no model calls, and it respects robots.txt and the same
 * rate limits as the main crawler.
 */
import { db } from "@/lib/db";
import { politeFetch } from "@/scraper/fetcher";
import { detectRenderMode } from "@/scraper/render-mode";
import { detectLeaks } from "@/scraper/leaks";
import * as cheerio from "cheerio";

const argv = process.argv.slice(2);
const arg = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const limit = Number(arg("--limit")) || 40;
const industry = arg("--industry");

const targets = await db.company.findMany({
  where: {
    ...(industry ? { industry: { contains: industry, mode: "insensitive" } } : {}),
    websiteUrl: { not: null },
    siteAudit: { reachable: true, leakScore: 0 },
  },
  select: { id: true, name: true, websiteUrl: true },
  take: limit,
});

console.log(`re-reading ${targets.length} homepages for conversion leaks\n`);
let done = 0, leaky = 0, failed = 0;

for (const c of targets) {
  const r = await politeFetch(c.websiteUrl!);
  if (!r.ok) { failed++; continue; }

  const $ = cheerio.load(r.html);
  const render = detectRenderMode(r.html, $("body").text());
  const leak = detectLeaks(r.html, render.reliable);

  await db.siteAudit.updateMany({
    where: { companyId: c.id },
    data: {
      leakScore: leak.leakScore,
      leakFindings: leak.findings as object,
      missingH1: leak.signals.missingH1,
      noAboveFoldCta: leak.signals.noAboveFoldCta,
      formDepthPct: leak.signals.formDepthPct,
      distinctPrices: leak.signals.distinctPrices,
      hasPopup: leak.signals.hasPopup,
    },
  });
  done++;
  if (leak.leakScore > 0) {
    leaky++;
    console.log(`  ${String(leak.leakScore).padStart(3)}  ${c.name.slice(0, 34).padEnd(36)} ${leak.findings[0]?.slice(0, 70) ?? ""}`);
  }
  if (done % 20 === 0) console.log(`  ...${done}/${targets.length}`);
}

console.log(`\nread ${done} · ${leaky} leaking · ${failed} unreachable`);
await db.$disconnect();
