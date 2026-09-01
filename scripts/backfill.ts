/**
 * Deep discovery for one or more industries, straight into the database and
 * then into the Google Sheet.
 *
 *   npx tsx scripts/backfill.ts "aircon servicing" "HVAC" --limit 100
 *   npx tsx scripts/backfill.ts --sync-only
 *
 * Unlike the old adapter test scripts, every number this prints is a number of
 * rows that exist. It calls the same discoverIndustry() the web UI calls.
 */
import { db } from "@/lib/db";
import { discoverIndustry } from "@/lib/discover-industry";
import { buildExportData } from "@/lib/export-data";
import { syncBusinessSheet, sheetsConfigured } from "@/adapters/sheets";

const argv = process.argv.slice(2);
const flag = (n: string, d: number) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const limit = flag("limit", 100);
const syncOnly = argv.includes("--sync-only");
const industries = argv.filter((a) => !a.startsWith("--") && Number.isNaN(Number(a)));

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
console.log(`business: ${biz.name}`);
console.log(`sheet:    ${biz.sheetUrl ?? "(not connected)"}\n`);

if (!syncOnly) {
  if (industries.length === 0) {
    console.error('Pass at least one industry, e.g. npx tsx scripts/backfill.ts "aircon servicing"');
    process.exit(1);
  }
  for (const industry of industries) {
    const t0 = Date.now();
    process.stdout.write(`${industry.padEnd(28)} ... `);
    try {
      const r = await discoverIndustry(biz.id, industry, { limit });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `${secs}s  found ${r.found}  new ${r.created}  already held ${r.skippedKnown}` +
          `   [${r.adapterLog.map((a) => `${a.adapter}:${a.error ? "ERR" : a.found}`).join(" ")}]`,
      );
      for (const a of r.adapterLog) if (a.error) console.log(`    ! ${a.adapter}: ${a.error}`);
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    }
  }
}

const total = await db.company.count();
console.log(`\ndatabase now holds ${total} companies`);

if (!biz.sheetId) {
  console.log("No Sheet connected — connect one at /generator, then rerun with --sync-only.");
} else if (!sheetsConfigured()) {
  console.log("Sheets credentials not resolvable — check GOOGLE_APPLICATION_CREDENTIALS.");
} else {
  process.stdout.write("syncing to Google Sheet ... ");
  const data = await buildExportData(biz.id);
  await syncBusinessSheet(biz.id, data);
  console.log(
    `done — ${data.companies.length} companies, ${data.introductions.length} introductions, ${data.pairings.length} pairings`,
  );
  console.log(biz.sheetUrl);
}

await db.$disconnect();
