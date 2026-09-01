/**
 * Crawl the websites of companies already in the database and pull out contact
 * routes.
 *
 *   npx tsx scripts/enrich.ts                          # everything missing an email
 *   npx tsx scripts/enrich.ts --industry "dental clinic"
 *   npx tsx scripts/enrich.ts --all --concurrency 8    # re-crawl even if we have one
 *
 * Discovery and enrichment are deliberately separate passes. Discovery is a
 * search API call and takes ~50s for 100 companies; enrichment opens up to six
 * pages per site and takes ~10s per company. Running them together made a
 * hundred-company search look like it had hung, so the search now stores what
 * Google returned and this fills in the rest.
 *
 * Politeness is preserved under concurrency: the fetcher throttles per host, so
 * parallel workers on different domains never hit the same server faster than
 * the crawl delay allows.
 */
import pLimit from "p-limit";
import { db } from "@/lib/db";
import { ingestDomain } from "@/scraper/ingest";
import { buildExportData } from "@/lib/export-data";
import { syncBusinessSheet, sheetsConfigured } from "@/adapters/sheets";

const argv = process.argv.slice(2);
const val = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const industry = val("industry");
const concurrency = Number(val("concurrency") ?? 6);
const max = Number(val("max") ?? 10_000);
const all = argv.includes("--all");

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

const candidates = await db.company.findMany({
  where: {
    primaryDomain: { not: null },
    ...(industry ? { industry: { equals: industry, mode: "insensitive" } } : {}),
    // Default to the companies that have no email route at all. Re-crawling a
    // site we already have an inbox for spends someone else's bandwidth for
    // nothing.
    ...(all ? {} : { contacts: { none: { email: { not: null } } } }),
  },
  select: { id: true, name: true, websiteUrl: true, primaryDomain: true },
  take: max,
});

console.log(`${candidates.length} companies to crawl${industry ? ` in "${industry}"` : ""}, ${concurrency} at a time`);
console.log(`(~${Math.ceil((candidates.length * 10) / concurrency / 60)} min at ~10s per site)\n`);

const limit = pLimit(concurrency);
const reasons = new Map<string, number>();
let done = 0;
let emails = 0;
let phones = 0;
let contacts = 0;
let ok = 0;

const bump = (r: string) => reasons.set(r, (reasons.get(r) ?? 0) + 1);

await Promise.all(
  candidates.map((c) =>
    limit(async () => {
      const url = c.websiteUrl ?? `https://${c.primaryDomain}`;
      try {
        const r = await ingestDomain(biz.id, url, { knownName: c.name });
        if (r.skipped) bump(r.skipped);
        else {
          ok++;
          emails += r.emails;
          phones += r.phones;
          contacts += r.contactsCreated;
          if (!r.emails) bump("crawled, no email published");
        }
      } catch (e) {
        bump(`error: ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`);
      }
      done++;
      if (done % 25 === 0 || done === candidates.length) {
        process.stdout.write(`  ${done}/${candidates.length}  ${emails} emails  ${phones} phones\n`);
      }
    }),
  ),
);

console.log(`\ncrawled ok        ${ok}`);
console.log(`emails found      ${emails}`);
console.log(`phones found      ${phones}`);
console.log(`contact rows      ${contacts}`);
console.log(`\nwhy the rest yielded nothing:`);
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(4)}  ${r}`);
}

if (biz.sheetId && sheetsConfigured()) {
  process.stdout.write(`\nsyncing to Google Sheet ... `);
  const data = await buildExportData(biz.id);
  await syncBusinessSheet(biz.id, data);
  console.log(`done — ${data.companies.length} companies`);
  console.log(biz.sheetUrl);
}

await db.$disconnect();
