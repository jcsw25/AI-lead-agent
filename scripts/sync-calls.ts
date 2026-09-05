/**
 * Two-way sync of the Calls tab in the Google Sheet.
 *
 *   npx tsx scripts/sync-calls.ts
 *
 * Reads what you typed into the Sheet, records it, then writes the queue back.
 * Safe to run repeatedly — a call already logged is not logged twice, and your
 * columns are never overwritten with blanks.
 */
import { db } from "@/lib/db";
import { syncCallsTab } from "@/lib/calls/sheet";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const r = await syncCallsTab(biz.id);

console.log(`pulled in from the sheet   ${r.pulledIn}`);
console.log(`leads you added by hand    ${r.createdLeads}`);
console.log(`suppressed on your say-so  ${r.suppressed}`);
console.log(`rows written back          ${r.rowsWritten}`);
if (r.skipped.length) {
  console.log(`\ncould not read ${r.skipped.length}:`);
  for (const s of r.skipped) console.log(`  ${s}`);
}
console.log(`\n${r.url}`);
await db.$disconnect();
