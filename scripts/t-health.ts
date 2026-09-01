import { db } from "@/lib/db";
import { runHealthChecks } from "@/lib/health";
import { getProjectStatus } from "@/lib/project-status";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
for (const p of await runHealthChecks(biz.id)) {
  console.log(`  ${p.status.toUpperCase().padEnd(15)} ${p.name.padEnd(30)} ${String(p.latencyMs ?? "-").padStart(5)}ms  ${p.detail.slice(0, 78)}`);
}
const s = await getProjectStatus(biz.id);
console.log(`\nspend: $${s.spend.totalUsd.toFixed(2)} across ${s.spend.byAgent.reduce((a, b) => a + b.runs, 0)} model runs`);
console.log(`\nrecommendations:`);
for (const r of s.recommendations) console.log(`  [${r.priority}] ${r.title}`);
await db.$disconnect();
