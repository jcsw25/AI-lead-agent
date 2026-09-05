import { db } from "@/lib/db";
import { discoverIndustry } from "@/lib/discover-industry";
import { scheduleEnrichment, currentEnrichment } from "@/lib/jobs/enrich-queue";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const IND = "office furniture supplier";

await discoverIndustry(biz.id, IND, { limit: 12 });
await scheduleEnrichment(biz.id, IND);

const light = (s: string) => (s === "done" ? "GREEN " : s === "running" ? "SPIN  " : s === "failed" ? "RED   " : "grey  ");
for (let i = 0; i < 14; i++) {
  const p = await currentEnrichment(biz.id);
  if (!p) break;
  const crawl = p.finished ? "done" : "running";
  const sheet = p.sheetSynced ? "done" : !p.finished ? "waiting" : p.sheetError ? "failed" : "waiting";
  console.log(`  ${light("done")}search   ${light(crawl)}crawl ${String(p.done).padStart(3)}/${p.total}   ${light(sheet)}sheets ${p.sheetSynced ? "synced" : (p.sheetError ?? "")}`);
  if (p.finished && (p.sheetSynced || p.sheetError)) break;
  await new Promise((r) => setTimeout(r, 8000));
}
await db.$disconnect();
