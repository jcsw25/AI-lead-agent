import { db } from "@/lib/db";
import { isDirectorySite } from "@/lib/entity";
const cs = await db.company.findMany({
  where: { description: { not: null } },
  select: { name: true, primaryDomain: true, description: true,
    qualifications: { select: { status: true, score: true } },
    introsAsA: { select: { id: true } }, introsAsB: { select: { id: true } } },
});
const hits = cs.map((c) => ({ c, why: isDirectorySite(c.description) })).filter((x) => x.why);
console.log(`${hits.length} flagged as directories (of ${cs.length} with descriptions)\n`);
for (const { c, why } of hits) {
  const n = c.introsAsA.length + c.introsAsB.length;
  console.log(`  ${(c.primaryDomain ?? "").padEnd(28)} ${String(c.qualifications[0]?.score ?? "-").padStart(3)}  ${String(n).padStart(2)} intros  ${why}`);
}
await db.$disconnect();
