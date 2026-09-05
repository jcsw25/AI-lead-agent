import { db } from "@/lib/db";
const runs = await db.scrapeRun.findMany({ orderBy: { startedAt: "desc" }, take: 5,
  select: { query: true, status: true, targetsAttempted: true, companiesCreated: true, startedAt: true } });
console.log("recent searches:");
for (const r of runs) console.log(`  ${r.startedAt.toLocaleTimeString()}  ${r.status.padEnd(8)} found=${r.targetsAttempted ?? 0} saved=${r.companiesCreated ?? 0}  ${r.query}`);

const plan = await db.queryPlan.findFirst({ where: { industry: { contains: "cater", mode: "insensitive" } } });
console.log(`\nquery plan for catering: ${plan ? `cached (${(plan.queries as unknown[]).length} queries, source ${plan.source}) — the model call is already paid for` : "none"}`);
if (plan) for (const q of plan.queries as Array<{ intent: string; query: string }>) console.log(`   ${q.intent.padEnd(15)} ${q.query}`);

console.log(`\ncompanies ${await db.company.count()} · prospects ${await db.prospect.count()} · introductions ${await db.introduction.count()}`);
await db.$disconnect();
