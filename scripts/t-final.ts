import { db } from "@/lib/db";
import { currentEnrichment } from "@/lib/jobs/enrich-queue";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const p = await currentEnrichment(biz.id);
if (!p) { console.log("no run"); process.exit(0); }
console.log(`industry     ${p.industry}`);
console.log(`crawl        ${p.done}/${p.total}  ${p.finished ? "finished" : "still running"}`);
console.log(`emails       ${p.emails}   phones ${p.phones}`);
console.log(`sheet synced ${p.sheetSynced}${p.sheetError ? "  (" + p.sheetError + ")" : ""}`);
console.log(`\nlights the page would show:`);
console.log(`  search  GREEN`);
console.log(`  crawl   ${p.finished ? "GREEN" : "SPINNING"}`);
console.log(`  sheets  ${p.sheetSynced ? "GREEN" : p.sheetError ? "RED" : "grey"}`);
await db.$disconnect();
