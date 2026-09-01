import { db } from "@/lib/db";
const DIRECTORY_WORDS = /\b(directory|listings?|marketplace|compare|comparison|find (?:a|the best)|reviews? (?:of|site)|portal|aggregator|platform (?:for|connecting)|classifieds?|search engine for)\b/i;

const cs = await db.company.findMany({
  where: { description: { not: null } },
  select: {
    name: true, primaryDomain: true, description: true, industry: true,
    qualifications: { select: { status: true, score: true } },
    introsAsA: { select: { id: true } }, introsAsB: { select: { id: true } },
  },
});
const hits = cs.filter((c) => DIRECTORY_WORDS.test(c.description ?? ""));
const live = hits.filter((c) => c.introsAsA.length + c.introsAsB.length > 0 || c.qualifications.some((q) => q.status === "QUALIFIED"));

console.log(`${cs.length} companies with a description`);
console.log(`  read as a directory/portal        ${hits.length}`);
console.log(`  ...qualified or in introductions  ${live.length}\n`);
for (const c of live.slice(0, 12)) {
  const n = c.introsAsA.length + c.introsAsB.length;
  console.log(`  ${(c.primaryDomain ?? "").padEnd(30)} ${String(c.qualifications[0]?.score ?? "-").padStart(3)}  ${n} intros  ${(c.description ?? "").replace(/\s+/g," ").slice(0, 70)}`);
}
await db.$disconnect();
