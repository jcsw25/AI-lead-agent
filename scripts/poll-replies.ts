/**
 * Pull replies from the connected Gmail mailbox and classify them.
 *
 *   npm run replies
 *
 * Safe to run repeatedly — already-recorded messages are skipped.
 */
import { db } from "@/lib/db";
import { pollReplies } from "@/lib/outreach/replies";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
try {
  const r = await pollReplies(biz.id);
  console.log(`fetched      ${r.fetched}`);
  console.log(`matched      ${r.matched}  (to a company we contacted)`);
  console.log(`unsubscribes ${r.unsubscribes}  → suppression list`);
console.log(`own mail      ${r.skippedOwn}  (copies of what we sent, not replies)`);
  if (Object.keys(r.byClass).length) {
    console.log(`\nby class:`);
    for (const [k, v] of Object.entries(r.byClass).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
  if (r.unmatched.length) console.log(`\n${r.unmatched.length} inbox messages from addresses we never wrote to (ignored)`);

  if (r.extracted.length) {
    console.log(`\nwhat they said:`);
    for (const x of r.extracted) {
      console.log(`  ${x.status.padEnd(9)} ${x.companyName} — ${x.why}`);
      if (x.verbatim) console.log(`            "${x.verbatim}"`);
      if (x.incumbent) console.log(`            uses: ${x.incumbent}`);
      if (x.otherNeedCreated) console.log(`            also raised: ${x.otherNeedCreated}`);
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
}
await db.$disconnect();
