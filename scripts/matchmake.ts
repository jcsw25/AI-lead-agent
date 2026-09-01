import { db } from "@/lib/db";
import { runMatchmakerScout } from "@/agents/matchmaker-scout";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const t0 = Date.now();
const r = await runMatchmakerScout(biz.id, { sampleSize: 40 });
console.log(`${r.created} proposed, ${r.skipped} dropped, in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (r.notes) console.log(`notes: ${r.notes}\n`);

const ms = await db.matchmake.findMany({
  where: { businessId: biz.id }, orderBy: { novelty: "desc" },
  include: { companyA: { select: { name: true, industry: true } }, companyB: { select: { name: true, industry: true } } },
});
for (const m of ms) {
  console.log(`${"=".repeat(76)}`);
  console.log(`${m.companyA.name} × ${m.companyB.name}`);
  console.log(`${m.companyA.industry} × ${m.companyB.industry}  ·  unusual ${Math.round(m.novelty*100)}% · confidence ${Math.round(m.confidence*100)}%${m.estimatedCommission ? ` · ~$${Number(m.estimatedCommission).toFixed(0)}` : ""}`);
  console.log(`${"=".repeat(76)}`);
  console.log(`  pitch:  ${m.pitch}`);
  console.log(`  A gets: ${m.valueToA}`);
  console.log(`  B gets: ${m.valueToB}`);
  if (m.whyNow) console.log(`  why now: ${m.whyNow}`);
  const asm = (m.assumptions as string[] | null) ?? [];
  if (asm.length) console.log(`  assumed: ${asm.join(" | ").slice(0, 130)}`);
}
await db.$disconnect();
