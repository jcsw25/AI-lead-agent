/**
 * Collect Singapore businesses currently advertised for sale.
 *
 *   npx tsx scripts/scrape-listings.ts
 *   npx tsx scripts/scrape-listings.ts --per-source 10
 *   npx tsx scripts/scrape-listings.ts --source businessforsale.sg
 *   npx tsx scripts/scrape-listings.ts --industry aircon
 *
 * Safe to re-run: a listing already collected is skipped without a fetch or a
 * model call, so a second run only picks up what is new.
 */
import { db } from "@/lib/db";
import { scrapeListings } from "@/lib/acquisition/listings";
import { MARKETPLACES } from "@/lib/acquisition/marketplaces";

const argv = process.argv.slice(2);
const arg = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const perSource = Number(arg("--per-source")) || 25;
const source = arg("--source");
const industry = arg("--industry");

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

console.log(
  `reading ${source ?? `${MARKETPLACES.length} sources`}, up to ${perSource} listings each` +
    (industry ? `, keeping only ${industry}` : "") +
    `\n`,
);

const r = await scrapeListings(biz.id, {
  perSource,
  industry,
  sources: source ? [source] : undefined,
  onProgress: (m) => console.log(`  ${m}`),
});

console.log(`\nsources read     ${r.sourcesRead}/${source ? 1 : MARKETPLACES.length}`);
console.log(`listing urls     ${r.urlsSeen}`);
console.log(`pages fetched    ${r.pagesFetched}`);
console.log(`targets created  ${r.created}`);
console.log(`cost             $${r.costUsd.toFixed(4)}`);

if (Object.keys(r.bySource).length) {
  console.log(`\nby source:`);
  for (const [k, v] of Object.entries(r.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
}

if (r.skipped.length) {
  const why = r.skipped.reduce<Record<string, number>>((a, s) => {
    const k = s.why.split("—")[0].trim();
    return { ...a, [k]: (a[k] ?? 0) + 1 };
  }, {});
  console.log(`\nskipped ${r.skipped.length}:`);
  for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
}

const made = await db.acquisitionTarget.findMany({
  where: { businessId: biz.id, origin: "LISTED" },
  orderBy: { createdAt: "desc" },
  take: Math.min(r.created, 15),
});
const money = (v: unknown, cur: string) => (v == null ? "—" : `${cur} ${Number(v).toLocaleString()}`);
for (const t of made) {
  console.log(`\n${t.name.slice(0, 90)}`);
  console.log(`  ${t.listingSource} · ${t.industry ?? "industry not stated"}`);
  console.log(
    `  asking ${money(t.askingPrice, t.currency)} · revenue ${money(t.revenue, t.currency)} · ` +
      `profit ${money(t.ebitda, t.currency)}${t.askingMultiple ? ` · ${t.askingMultiple}x` : ""}`,
  );
  if (t.sellerReason) console.log(`  selling because: ${t.sellerReason}`);
}

await db.$disconnect();
