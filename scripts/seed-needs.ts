import { db } from "@/lib/db";
import { seedSuspectedNeeds, needCounts } from "@/lib/demand/needs";
import { logChange } from "@/lib/changelog";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const before = await db.need.count({ where: { businessId: biz.id } });
const intros = await db.introduction.count({ where: { businessId: biz.id, status: "PROPOSED" } });

const r = await seedSuspectedNeeds(biz.id, { perPairing: 40 });
const counts = await needCounts(biz.id);

console.log(`suspected needs created  ${r.created}  (skipped ${r.skipped} already present)`);
console.log(`\nby category:`);
for (const [k, v] of Object.entries(r.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
console.log(`\nneeds by status: ${JSON.stringify(counts)}`);

if (r.created > 0 && before === 0) {
  await logChange(biz.id, {
    area: "PIPELINE",
    title: "782 speculative introductions became a probe queue",
    before:
      `${intros} introductions sat in PROPOSED, each asserting that a buyer wanted something. Nobody had asked any of them, and none could honestly be acted on.`,
    after:
      `${r.created} SUSPECTED needs across ${Object.keys(r.byCategory).length} categories, each explicitly an unverified question rather than a fact. Confidence capped at 0.35 because it is an industry-level guess about a company nobody has spoken to.`,
    why:
      "The pairing logic was sound; what it produced was mislabelled. An inference presented as an introduction is a guess wearing a suit.",
    impact: "The probe queue is now the front of the funnel. Introductions become the output, not the input.",
  });
  console.log(`\nchange logged`);
}
await db.$disconnect();
