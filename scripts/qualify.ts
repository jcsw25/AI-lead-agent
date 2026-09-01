/**
 * Score and qualify every company in the database.
 *
 *   npm run qualify
 *   npm run qualify -- --industry "aircon servicing"
 *
 * Deterministic and free: no model call, no network. Re-run it whenever the
 * weights change or new evidence lands.
 */
import { db } from "@/lib/db";
import { qualifyAll } from "@/lib/scoring/qualify";
import { activeScoringModel } from "@/lib/scoring/score";

const argv = process.argv.slice(2);
const i = argv.indexOf("--industry");
const industry = i >= 0 ? argv[i + 1] : undefined;

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const model = await activeScoringModel(biz.id);

console.log(`business: ${biz.name}`);
console.log(`weights (model v${model.version}):`);
for (const [k, v] of Object.entries(model.weights as Record<string, number>)) {
  console.log(`  ${k.padEnd(18)} ${v}`);
}

const t0 = Date.now();
const r = await qualifyAll(biz.id, { industry });
console.log(`\nscored in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

console.log(`qualified          ${r.qualified}`);
console.log(`needs review       ${r.review}`);
console.log(`rejected           ${r.rejected}`);
console.log(`new prospects      ${r.prospectsCreated}`);

console.log(`\nby grade:`);
for (const g of ["A", "B", "C", "D"]) {
  if (r.byGrade[g]) console.log(`  ${g}  ${r.byGrade[g]}`);
}

console.log(`\nwhy companies were rejected:`);
for (const [k, v] of Object.entries(r.byReason).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}

// The point of the whole exercise: a ranked list you can act on.
const top = await db.prospect.findMany({
  // Disqualified prospects are kept as history, not shown as leads.
  where: { businessId: biz.id, stage: { notIn: ["DISQUALIFIED", "SUPPRESSED", "LOST"] } },
  orderBy: { score: "desc" },
  take: 10,
  include: { company: { select: { name: true, primaryDomain: true, industry: true } } },
});
console.log(`\ntop prospects:`);
for (const p of top) {
  console.log(
    `  ${String(p.score).padStart(3)}  ${(p.tier ?? "").padEnd(5)} ${p.company.name.slice(0, 34).padEnd(36)} ${p.company.primaryDomain ?? ""}`,
  );
}

await db.$disconnect();
