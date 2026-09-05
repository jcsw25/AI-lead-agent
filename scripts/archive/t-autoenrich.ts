import { db } from "@/lib/db";
import { discoverIndustry } from "@/lib/discover-industry";
import { scheduleEnrichment, currentEnrichment, pendingEnrichment } from "@/lib/jobs/enrich-queue";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const INDUSTRY = "commercial printing";

const t0 = Date.now();
const r = await discoverIndustry(biz.id, INDUSTRY, { limit: 30 });
console.log(`search returned in ${((Date.now() - t0) / 1000).toFixed(1)}s — found ${r.found}, saved ${r.created}`);

console.log(`\nun-opened websites in this industry: ${await pendingEnrichment(INDUSTRY)}`);
const t1 = Date.now();
const s = await scheduleEnrichment(biz.id, INDUSTRY);
console.log(`scheduleEnrichment returned in ${Date.now() - t1}ms, queued ${s.started} sites`);
console.log(`(the point: the user is not waiting for this)`);

// watch it progress
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 12_000));
  const p = await currentEnrichment(biz.id);
  if (!p) { console.log(`\ncrawl finished`); break; }
  console.log(`  ${p.done}/${p.total} sites · ${p.emails} emails · ${p.phones} phones`);
}

const after = await db.company.findMany({
  where: { industry: { equals: INDUSTRY, mode: "insensitive" } },
  select: { contacts: { select: { email: true, phone: true } }, siteAudit: { select: { reachable: true } } },
});
console.log(`\n${INDUSTRY}: ${after.length} companies`);
console.log(`  sites opened   ${after.filter((c) => c.siteAudit).length}`);
console.log(`  with an email  ${after.filter((c) => c.contacts.some((x) => x.email)).length}`);
console.log(`  with a phone   ${after.filter((c) => c.contacts.some((x) => x.phone)).length}`);
await db.$disconnect();
