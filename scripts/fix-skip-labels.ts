/** Reclassify past runs where a deliberate skip was recorded as a failure. */
import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const runs = await db.scrapeRun.findMany({ where: { businessId: biz.id, mode: "search" } });
let fixed = 0;
for (const r of runs) {
  const log = r.log as { adapters?: Array<{ adapter: string; found: number; error?: string; skipped?: string }> } | null;
  if (!log?.adapters) continue;
  let touched = false;
  for (const a of log.adapters) {
    if (a.error?.startsWith("skipped")) {
      a.skipped = "not needed — Google already returned enough";
      delete a.error;
      touched = true;
    }
  }
  if (!touched) continue;
  const realErrors = log.adapters.filter((a) => a.error).map((a) => `${a.adapter}: ${a.error}`).join(" | ") || null;
  await db.scrapeRun.update({ where: { id: r.id }, data: { log: log as object, error: realErrors } });
  fixed++;
}
console.log(`relabelled ${fixed} past runs — a skipped adapter no longer reads as a failure`);
await db.$disconnect();
