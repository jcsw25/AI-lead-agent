import { db } from "@/lib/db";

const businesses = await db.business.findMany({
  select: { id: true, name: true, sheetId: true, sheetUrl: true, sheetAutoSync: true, sheetSyncedAt: true },
});
console.log("BUSINESSES:");
for (const b of businesses) {
  console.log(`  ${b.name}  id=${b.id}`);
  console.log(`    sheetId=${b.sheetId ?? "(none)"}  autoSync=${b.sheetAutoSync}  lastSync=${b.sheetSyncedAt ?? "never"}`);
}

const total = await db.company.count();
console.log(`\nCOMPANIES: ${total}`);
const byIndustry = await db.company.groupBy({ by: ["industry"], _count: { _all: true }, orderBy: { _count: { id: "desc" } } });
for (const r of byIndustry) console.log(`  ${r._count._all.toString().padStart(4)}  ${r.industry ?? "(null)"}`);

console.log(`\nCONTACTS: ${await db.contact.count()}`);
console.log(`SUPPLIER LEADS: ${await db.supplierLead.count()}`);
console.log(`PROSPECTS: ${await db.prospect.count()}`);
console.log(`CLAIMS: ${await db.claim.count()}`);

const runs = await db.scrapeRun.findMany({ orderBy: { startedAt: "desc" }, take: 10, select: { query: true, status: true, targetsAttempted: true, companiesCreated: true, startedAt: true, error: true } });
console.log("\nRECENT SCRAPE RUNS:");
for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(0,16)}  ${r.status.padEnd(6)}  attempted=${r.targetsAttempted ?? 0} created=${r.companiesCreated ?? 0}  ${r.query}${r.error ? "  ERR:" + r.error.slice(0,80) : ""}`);

await db.$disconnect();
