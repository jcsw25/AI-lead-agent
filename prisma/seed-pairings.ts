/**
 * Seed pairings: reusable A→B theses.
 *
 * Each answers the question the whole business rests on — what does company A
 * have that company B needs, and what makes B act now? These are starting
 * hypotheses, not researched facts: `confidence` reflects that, and the Pairing
 * Scout can add and re-rank them once real outcome data exists.
 *
 *   npm run db:seed:pairings
 */
import { PrismaClient, type PlayLane } from "@prisma/client";

const db = new PrismaClient();

import { PAIRINGS, type PairingSeed as P } from "./pairings-data";

/** Same shape as the other rankers: model supplies judgment, code supplies order. */
function score(p: P): number {
  return Number((p.demand * 0.35 + p.supply * 0.25 + (1 - p.comp) * 0.2 + p.conf * 0.2).toFixed(3));
}

async function main() {
  const business = await db.business.findFirst({ orderBy: { createdAt: "asc" } });
  if (!business) throw new Error("No business found — run `npm run db:seed` first.");

  let created = 0;
  for (const p of PAIRINGS) {
    const exists = await db.pairing.findFirst({
      where: { businessId: business.id, supplierIndustry: p.a, buyerIndustry: p.b },
    });
    if (exists) continue;
    await db.pairing.create({
      data: {
        businessId: business.id,
        supplierIndustry: p.a,
        buyerIndustry: p.b,
        lane: p.lane as PlayLane,
        whatAHas: p.has,
        whatBNeeds: p.needs,
        trigger: p.trigger,
        timingWindow: p.window,
        reachA: p.reachA,
        reachB: p.reachB,
        typicalDealLow: p.low,
        typicalDealHigh: p.high,
        commissionRate: p.rate,
        demandStrength: p.demand,
        supplyEase: p.supply,
        competition: p.comp,
        confidence: p.conf,
        score: score(p),
        status: "proposed",
        evidence: [{ claim: "Seeded hypothesis — not researched. Confidence reflects that.", confidence: p.conf }],
      },
    });
    created++;
  }
  console.log(`Pairings: ${created} created, ${PAIRINGS.length - created} already present.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
