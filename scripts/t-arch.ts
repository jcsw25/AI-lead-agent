import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const run = await db.scrapeRun.findFirst({
  where: { businessId: biz.id, mode: "enrich" }, orderBy: { startedAt: "desc" },
});
console.log(`run:    ${run?.query}`);
console.log(`status: ${run?.status}`);
console.log(`log:    ${JSON.stringify(run?.log)?.slice(0, 200)}`);
const b = await db.business.findUniqueOrThrow({ where: { id: biz.id }, select: { sheetSyncedAt: true, sheetAutoSync: true, sheetId: true } });
console.log(`\nsheet last synced: ${b.sheetSyncedAt?.toLocaleTimeString()}`);
console.log(`auto-sync: ${b.sheetAutoSync}  connected: ${Boolean(b.sheetId)}`);
await db.$disconnect();
