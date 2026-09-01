import { db } from "@/lib/db";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
console.log(`business:   ${biz.name}`);
console.log(`replyTo:    ${(biz as { replyToEmail?: string | null }).replyToEmail ?? "(not set)"}`);

const counts: Record<string, number> = {
  companies: await db.company.count(),
  prospects: await db.prospect.count(),
  supplierLeads: await db.supplierLead.count(),
  matches: await db.match.count(),
  pairings: await db.pairing.count(),
  scoreSnapshots: await db.scoreSnapshot.count(),
  scoringModels: await db.scoringModel.count(),
  outcomeStats: await db.outcomeStat.count(),
  messages: await db.message.count(),
  sendLedger: await db.sendLedgerEntry.count(),
  campaigns: await db.campaign.count(),
  deals: await db.deal.count(),
};
console.log("\npipeline:");
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(16)} ${v}`);

// Does the pairing library actually cover the industries discovery produced?
const industries = [
  ...new Set((await db.company.findMany({ select: { industry: true } })).map((c) => c.industry).filter(Boolean)),
] as string[];
const pairings = await db.pairing.findMany({ select: { supplierIndustry: true, buyerIndustry: true } });
const covered = new Set(pairings.flatMap((p) => [p.supplierIndustry.toLowerCase(), p.buyerIndustry.toLowerCase()]));

console.log("\nindustry -> is it in the pairing library?");
for (const i of industries) {
  const exact = covered.has(i.toLowerCase());
  const fuzzy = [...covered].some((c) => c.includes(i.toLowerCase()) || i.toLowerCase().includes(c));
  console.log(`  ${exact ? "exact " : fuzzy ? "fuzzy " : "  NO  "}  ${i}`);
}

await db.$disconnect();
