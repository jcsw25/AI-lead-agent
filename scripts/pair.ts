/**
 * Generate pairings for the industries actually in the database, then compute
 * company-level introductions from them.
 *
 *   npm run pair              # generate theses, then match companies
 *   npm run pair -- --match-only
 *
 * The generation step costs one Opus call. Matching is deterministic and free.
 */
import { db } from "@/lib/db";
import { generatePairingsForDatabase } from "@/agents/pairing-generator";
import { buildIntroductions } from "@/lib/matching/introduce";

const argv = process.argv.slice(2);
const matchOnly = argv.includes("--match-only");

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
console.log(`business: ${biz.name}\n`);

if (!matchOnly) {
  process.stdout.write("generating pairings ... ");
  const t0 = Date.now();
  const g = await generatePairingsForDatabase(biz.id);
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  created ${g.created}, updated ${g.updated}, both sides present ${g.bothSides}`);
  if (g.notes) console.log(`  ${g.notes}`);

  const fresh = await db.pairing.findMany({
    where: { businessId: biz.id, agentRunId: g.runId ?? undefined },
    orderBy: { score: "desc" },
  });
  console.log(`\nnew theses:`);
  for (const p of fresh) {
    const both = (p.evidence as { bothSidesPresent?: boolean } | null)?.bothSidesPresent;
    console.log(
      `  ${p.score.toFixed(2)}  ${both ? "[both]" : "      "} ${p.lane.padEnd(11)} ` +
        `${p.supplierIndustry.slice(0, 26).padEnd(28)} -> ${p.buyerIndustry.slice(0, 30)}`,
    );
    console.log(`         ${p.trigger.slice(0, 120)}`);
  }
}

process.stdout.write(`\nmatching companies ... `);
const t1 = Date.now();
const m = await buildIntroductions(biz.id);
console.log(`${((Date.now() - t1) / 1000).toFixed(1)}s`);
console.log(`  ${m.created} introductions created, ${m.updated} updated`);
console.log(`  ${m.pairingsProcessed} pairings had companies on both sides`);

if (m.byPairing.length) {
  console.log(`\nintroductions per pairing:`);
  for (const b of m.byPairing.sort((a, c) => c.topScore - a.topScore)) {
    console.log(`  ${b.topScore.toFixed(2)}  ${String(b.introductions).padStart(3)}  ${b.pairing}`);
  }
}

if (m.pairingsSkipped.length) {
  console.log(`\nskipped (${m.pairingsSkipped.length}):`);
  for (const s of m.pairingsSkipped.slice(0, 8)) console.log(`  ${s.pairing.slice(0, 52).padEnd(54)} ${s.why}`);
  if (m.pairingsSkipped.length > 8) console.log(`  ... and ${m.pairingsSkipped.length - 8} more`);
}

const top = await db.introduction.findMany({
  where: { businessId: biz.id },
  orderBy: { fitScore: "desc" },
  take: 10,
  include: {
    companyA: { select: { name: true, primaryDomain: true } },
    companyB: { select: { name: true, primaryDomain: true } },
    pairing: { select: { supplierIndustry: true, buyerIndustry: true } },
  },
});
console.log(`\ntop introductions:`);
for (const i of top) {
  console.log(
    `  ${i.fitScore.toFixed(2)}  ${i.companyA.name.slice(0, 24).padEnd(26)} -> ${i.companyB.name.slice(0, 24).padEnd(26)}` +
      `  ${i.estimatedCommission ? `~$${Number(i.estimatedCommission).toFixed(0)}` : ""}`,
  );
}

const totalCommission = (
  await db.introduction.findMany({ where: { businessId: biz.id }, select: { estimatedCommission: true } })
).reduce((s, i) => s + Number(i.estimatedCommission ?? 0), 0);
console.log(`\n${await db.introduction.count({ where: { businessId: biz.id } })} introductions on the board`);
console.log(`estimated commission if every one closed: $${totalCommission.toLocaleString()}`);
console.log(`(that is a ceiling, not a forecast — nothing has been contacted)`);

await db.$disconnect();
