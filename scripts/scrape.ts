import { PrismaClient } from "@prisma/client";
import { ingestMany } from "../src/scraper/ingest";

const db = new PrismaClient();
const domains = process.argv.slice(2);
if (!domains.length) { console.log("usage: npm run scrape -- domain1.com domain2.com"); process.exit(1); }

const business = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const pairing = await db.pairing.findFirst({
  where: { businessId: business.id, supplierIndustry: { contains: "Automation" } },
});

console.log(`Scraping ${domains.length} domains for pairing: ${pairing?.supplierIndustry ?? "none"} -> ${pairing?.buyerIndustry ?? "-"}\n`);
const { results } = await ingestMany(business.id, domains, { pairingId: pairing?.id, asSupplierLead: true });

for (const r of results) {
  console.log(`${r.domain.padEnd(28)} ${String(r.score).padStart(3)}/100 ${r.tier.padEnd(12)} ${r.emails}e ${r.phones}p ${r.contactsCreated}c${r.skipped ? "  SKIP: " + r.skipped : ""}`);
}
const ok = results.filter(r => !r.skipped);
console.log(`\n${ok.length}/${results.length} scraped · ${ok.filter(r=>r.emails>0).length} with email · ${ok.filter(r=>r.phones>0).length} with phone`);
await db.$disconnect();
