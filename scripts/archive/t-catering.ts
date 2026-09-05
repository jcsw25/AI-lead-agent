import { db } from "@/lib/db";
const cs = await db.company.findMany({
  where: { industry: { contains: "cater", mode: "insensitive" } },
  select: { name: true, primaryDomain: true, description: true, contacts: { select: { email: true, phone: true } }, siteAudit: { select: { reachable: true } } },
});
console.log(`Food Catering companies      ${cs.length}`);
console.log(`  with a website             ${cs.filter((c) => c.primaryDomain).length}`);
console.log(`  site ever opened (audited) ${cs.filter((c) => c.siteAudit).length}`);
console.log(`  description on file        ${cs.filter((c) => c.description).length}`);
console.log(`  with an email              ${cs.filter((c) => c.contacts.some((x) => x.email)).length}`);
console.log(`  with a phone               ${cs.filter((c) => c.contacts.some((x) => x.phone)).length}`);

const run = await db.scrapeRun.findFirst({ where: { query: { contains: "cater", mode: "insensitive" }, status: "done" }, orderBy: { startedAt: "desc" } });
const log = run?.log as { crawled?: number; created?: number } | null;
console.log(`\nlast catering search: created=${log?.created ?? "?"}  crawled=${log?.crawled ?? "?"}`);
await db.$disconnect();
