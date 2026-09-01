import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const cs = await db.company.findMany({
  where: { industry: { contains: "logistics", mode: "insensitive" } },
  select: { primaryDomain: true, siteAudit: { select: { reachable: true } }, contacts: { select: { email: true, phone: true } } },
});
console.log(`logistics companies      ${cs.length}`);
console.log(`  with a website         ${cs.filter((c) => c.primaryDomain).length}`);
console.log(`  sites opened           ${cs.filter((c) => c.siteAudit).length}`);
console.log(`  with an email          ${cs.filter((c) => c.contacts.some((x) => x.email)).length}`);

console.log(`\nall enrich runs, newest first:`);
const runs = await db.scrapeRun.findMany({ where: { businessId: biz.id, mode: "enrich" }, orderBy: { startedAt: "desc" }, take: 6 });
for (const r of runs) {
  const log = r.log as { done?: number; emails?: number } | null;
  console.log(`  ${r.startedAt.toLocaleTimeString()}  ${r.status.padEnd(8)} ${String(r.targetsAttempted ?? 0).padStart(4)} targets  done=${log?.done ?? 0}  ${r.query}`);
}
console.log(`\nany enrich run for logistics? ${runs.some((r) => (r.query ?? "").includes("logistics")) ? "yes" : "NO — it was never scheduled"}`);
await db.$disconnect();
