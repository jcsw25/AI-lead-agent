/**
 * Read every reply that has not been read yet.
 *
 *   npx tsx scripts/extract-replies.ts [--limit 25]
 *
 * Extraction normally runs inside the reply poll, the moment a reply lands.
 * This is the backfill: replies captured before the extractor existed, and any
 * that failed at the time. Safe to run repeatedly — a need that already carries
 * a sourceMessageId pointing at a reply is skipped.
 */
import { db } from "@/lib/db";
import { extractPending } from "@/lib/demand/extract";
import { logChange } from "@/lib/changelog";

const argv = process.argv.slice(2);
const limit = Number(argv[argv.indexOf("--limit") + 1]) || 25;

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

const before = await db.need.groupBy({
  by: ["status"],
  where: { businessId: biz.id },
  _count: { _all: true },
});
const beforeCounts = Object.fromEntries(before.map((r) => [r.status, r._count._all]));

const results = await extractPending(biz.id, { limit });

if (results.length === 0) {
  console.log("Nothing to read — every reply already has a need pointing at it.");
} else {
  const cost = results.reduce((a, r) => a + r.costUsd, 0);
  for (const r of results) {
    console.log(`\n${r.status.padEnd(9)} ${r.companyName}`);
    console.log(`          ${r.why}`);
    if (r.verbatim) console.log(`          "${r.verbatim}"`);
    if (r.incumbent) console.log(`          uses: ${r.incumbent}`);
    if (r.otherNeedCreated) console.log(`          also raised: ${r.otherNeedCreated}`);
  }

  const by = results.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
  console.log(
    `\n${results.length} replies read · ` +
      Object.entries(by).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ") +
      ` · $${cost.toFixed(4)}`,
  );

  const confirmed = by.CONFIRMED ?? 0;
  if (confirmed > 0) {
    await logChange(biz.id, {
      area: "PIPELINE",
      title: `${confirmed} need${confirmed === 1 ? "" : "s"} confirmed from replies`,
      before: `${beforeCounts.CONFIRMED ?? 0} confirmed needs. Replies were classified HOT or NEGATIVE and nothing more, so nothing a buyer wrote could ever reach a supplier.`,
      after: `Replies are now read for what they say: the need, the incumbent, the timing, any budget figure, and anything they raised themselves. ${confirmed} reached CONFIRMED, each carrying the exact words and the message id they came from.`,
      why: "A supplier can only be told about a need somebody actually stated. The quote is verified against the reply text in code — an inexact one discards the whole extraction rather than confirming a need on words nobody wrote.",
    });
  }
}

await db.$disconnect();
