import { db } from "@/lib/db";

const companies = await db.company.findMany({
  select: {
    id: true, name: true, industry: true, primaryDomain: true, websiteUrl: true,
    lastResearchedAt: true, contacts: { select: { email: true, phone: true, fullName: true, jobTitle: true } },
  },
});

const withSite = companies.filter((c) => c.primaryDomain);
const withAnyContact = companies.filter((c) => c.contacts.length);
const withEmail = companies.filter((c) => c.contacts.some((x) => x.email));
const withPhone = companies.filter((c) => c.contacts.some((x) => x.phone));
const named = companies.filter((c) => c.contacts.some((x) => x.jobTitle && x.jobTitle !== "General enquiries"));

const pct = (n: number) => `${((n / companies.length) * 100).toFixed(0)}%`;
console.log(`companies              ${companies.length}`);
console.log(`  with a domain        ${withSite.length}  ${pct(withSite.length)}`);
console.log(`  with any contact row ${withAnyContact.length}  ${pct(withAnyContact.length)}`);
console.log(`  with an email        ${withEmail.length}  ${pct(withEmail.length)}`);
console.log(`  with a phone         ${withPhone.length}  ${pct(withPhone.length)}`);
console.log(`  with a NAMED person  ${named.length}  ${pct(named.length)}`);

const claims = await db.claim.groupBy({ by: ["field"], _count: { _all: true } });
console.log(`\nclaims by field:`);
for (const c of claims) console.log(`  ${c._count._all.toString().padStart(4)}  ${c.field}`);

// Was anything actually crawled? A crawl writes a Claim sourced from the company's
// own site; a SERP-only company has at most a phone scraped out of a snippet.
const runs = await db.scrapeRun.findMany({
  orderBy: { startedAt: "desc" }, take: 8,
  select: { query: true, status: true, targetsAttempted: true, companiesCreated: true, log: true },
});
console.log(`\nrecent runs — crawled?`);
for (const r of runs) {
  const log = r.log as { crawled?: number; created?: number } | null;
  console.log(`  ${(r.query ?? "").slice(0, 34).padEnd(36)} created=${log?.created ?? "?"} crawled=${log?.crawled ?? "?"}`);
}

console.log(`\nsample of companies with no contact at all:`);
for (const c of companies.filter((x) => !x.contacts.length).slice(0, 8)) {
  console.log(`  ${c.name.slice(0, 34).padEnd(36)} ${c.websiteUrl ?? "(no site)"}`);
}

await db.$disconnect();
