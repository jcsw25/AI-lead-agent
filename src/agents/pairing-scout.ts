import { z } from "zod/v4";
import type { PlayLane } from "@prisma/client";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";

/**
 * PAIRING SCOUT
 *
 * Generates new A→B theses. A hand-written library runs out; this does not.
 *
 * It works sector by sector rather than open-ended, because "suggest some
 * business pairings" produces the same dozen obvious ones every time. Given one
 * supplier sector and a trigger vocabulary, the model has to find buyers for
 * THAT sector specifically, which forces it into corners of the economy nobody
 * lists on a pitch deck — grease trap servicing, water tank certification,
 * statutory audiometry.
 *
 * The selection principle it is held to: the best pairing is one where the
 * buyer faces an externally imposed deadline. Licences expire, audits are
 * scheduled, leases hand over, festivals arrive. Those purchases happen whether
 * or not anyone feels like it.
 */

const Pairing = z.object({
  supplierIndustry: z.string(),
  buyerIndustry: z.string(),
  lane: z.enum(["DIRECT", "ADJACENT", "SEASONAL", "TRIGGER", "CHANNEL", "CONTRARIAN"]),
  whatAHas: z.string(),
  whatBNeeds: z.string(),
  trigger: z.string(),
  timingWindow: z.string().optional(),
  /** Which of the four kinds of deadline this is — or NONE, stated honestly. */
  deadlineType: z.enum(["REGULATORY", "CONTRACTUAL", "SEASONAL", "LIFECYCLE", "NONE"]),
  reachA: z.array(z.string()).min(1),
  reachB: z.array(z.string()).min(1),
  typicalDealLow: z.number(),
  typicalDealHigh: z.number(),
  commissionRate: z.number(),
  demandStrength: z.number().min(0).max(1),
  supplyEase: z.number().min(0).max(1),
  competition: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
});

export type PairingOut = z.infer<typeof Pairing>;

const Input = z.object({
  regionName: z.string(),
  currency: z.string(),
  supplierSector: z.string(),
  count: z.number().min(1).max(15),
  existingPairs: z.array(z.string()),
});

const Output = z.object({
  pairings: z.array(Pairing),
  /** Sectors this one should not be paired with, and why. Useful negative signal. */
  rejected: z.array(z.object({ buyerIndustry: z.string(), why: z.string() })),
});

const SYSTEM = `You find commercial pairings for a brokerage: which industry should be
introduced to which, and why the buyer acts now.

For the given SUPPLIER sector, find buyer industries that need what it provides.

Rank your ideas by the kind of deadline the buyer faces, strongest first:
  REGULATORY   a licence, certificate, statutory audit or inspection with a date attached
  CONTRACTUAL  a lease handover, a contract expiry, a client requirement, a tender
  SEASONAL     a festival, a peak trading period, a financial year end
  LIFECYCLE    funding, expansion, a merger, a new hire, a founder retiring
  NONE         discretionary. Include at most one of these, and score demand low.

Rules:
- The buyer must have a reason to act on a DATE, not merely a preference. A pairing whose
  trigger is "they might want to improve efficiency" is worthless — either find the real
  deadline or set deadlineType NONE and score it honestly.
- whatBNeeds must be written from the BUYER's point of view, in the terms they would use.
  Not "they need our automation services" but "they wait for the customer to call, and
  every forgotten service is revenue that disappears".
- reachB must name the role that holds the budget for this specific purchase. In an SME
  that is often the owner; do not invent a Chief Procurement Officer at a 12-person firm.
- Deal sizes must be realistic for the named market and business size. An SME service
  contract is thousands, not hundreds of thousands.
- Prefer unglamorous, low-competition sectors. Everyone targets tech companies and banks;
  almost nobody targets waste haulage, laundries, or MCST managing agents, and those
  buyers answer the phone.
- Do not repeat any pairing in the existing list.
- Do not invent statistics or name specific companies.`;

export function scorePairing(p: {
  demandStrength: number; supplyEase: number; competition: number; confidence: number;
}): number {
  return Number(
    (p.demandStrength * 0.35 + p.supplyEase * 0.25 + (1 - p.competition) * 0.2 + p.confidence * 0.2).toFixed(3),
  );
}

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "PAIRING_SCOUT",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) => `Market: ${i.regionName} (${i.currency})
Supplier sector: ${i.supplierSector}
Produce ${i.count} pairings for this sector.

Already covered — do not repeat:
${i.existingPairs.length ? i.existingPairs.map((x) => `- ${x}`).join("\n") : "(nothing yet)"}`,
  mock: (i) => ({
    pairings: [
      {
        supplierIndustry: i.supplierSector,
        buyerIndustry: "Simulated buyer industry",
        lane: "TRIGGER" as const,
        whatAHas: `Capability typical of ${i.supplierSector}.`,
        whatBNeeds: "Simulated — no model was called, so no real pairing was reasoned about.",
        trigger: "Simulated trigger.",
        timingWindow: "n/a",
        deadlineType: "NONE" as const,
        reachA: ["Owner"],
        reachB: ["Operations Manager"],
        typicalDealLow: 5000,
        typicalDealHigh: 25000,
        commissionRate: 12,
        demandStrength: 0.3, supplyEase: 0.3, competition: 0.5, confidence: 0.1,
      },
    ],
    rejected: [{ buyerIndustry: "—", why: "Simulated output. Add ANTHROPIC_API_KEY to generate real pairings." }],
  }),
};

/**
 * Supplier sectors to sweep. Broad on purpose: the point is to force the scout
 * into parts of the economy a brainstorm never reaches.
 */
export const SUPPLIER_SECTORS = [
  "Facilities and building maintenance services",
  "Commercial cleaning and hygiene services",
  "Waste, recycling and environmental services",
  "Security services and systems",
  "Accounting, bookkeeping and tax services",
  "Legal and corporate secretarial services",
  "HR, recruitment and payroll services",
  "IT support, software development and automation",
  "Cybersecurity and data protection services",
  "Marketing, design and content production",
  "Printing, signage and packaging",
  "Logistics, warehousing and delivery",
  "Fleet, vehicles and transport services",
  "Manufacturing and industrial fabrication",
  "Construction, fit-out and trades",
  "Architecture, engineering and surveying",
  "Food production, catering and beverage supply",
  "Wholesale and distribution",
  "Healthcare, clinics and allied health",
  "Training, education and certification",
  "Insurance, finance and lending",
  "Real estate, leasing and property management",
  "Travel, events and hospitality services",
  "Equipment rental and leasing",
  "Laboratory, testing and inspection services",
  "Agriculture, landscaping and horticulture",
  "Uniforms, textiles and workwear",
  "Furniture, fixtures and interiors supply",
  "Energy, utilities and sustainability services",
  "Translation, localisation and language services",
];

export async function runPairingScout(businessId: string, supplierSector: string, count = 8) {
  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { region: true },
  });

  const existing = await db.pairing.findMany({
    where: { businessId },
    select: { supplierIndustry: true, buyerIndustry: true },
    take: 400,
  });

  const { output, runId, simulated } = await runAgent(
    agent,
    {
      regionName: business.region.name,
      currency: business.region.currency,
      supplierSector,
      count,
      existingPairs: existing.map((e) => `${e.supplierIndustry} → ${e.buyerIndustry}`),
    },
    { businessId },
  );

  let created = 0;
  for (const p of output.pairings) {
    const dup = await db.pairing.findFirst({
      where: { businessId, supplierIndustry: p.supplierIndustry, buyerIndustry: p.buyerIndustry },
    });
    if (dup) continue;

    await db.pairing.create({
      data: {
        businessId,
        supplierIndustry: p.supplierIndustry,
        buyerIndustry: p.buyerIndustry,
        lane: p.lane as PlayLane,
        whatAHas: p.whatAHas,
        whatBNeeds: p.whatBNeeds,
        trigger: p.trigger,
        timingWindow: p.timingWindow ?? null,
        reachA: p.reachA,
        reachB: p.reachB,
        typicalDealLow: p.typicalDealLow,
        typicalDealHigh: p.typicalDealHigh,
        commissionRate: p.commissionRate,
        currency: business.region.currency,
        demandStrength: p.demandStrength,
        supplyEase: p.supplyEase,
        competition: p.competition,
        confidence: p.confidence,
        score: scorePairing(p),
        status: "proposed",
        evidence: [
          { claim: `Generated for sector "${supplierSector}". Deadline type: ${p.deadlineType}.`, confidence: p.confidence },
          ...output.rejected.slice(0, 2).map((r) => ({ claim: `Rejected ${r.buyerIndustry}: ${r.why}`, confidence: 0.3 })),
        ],
        agentRunId: runId,
      },
    });
    created++;
  }

  return { created, proposed: output.pairings.length, rejected: output.rejected.length, simulated };
}

/** Sweep every sector. This is how the library goes from dozens to hundreds. */
export async function sweepAllSectors(businessId: string, perSector = 8) {
  const results: Array<{ sector: string; created: number }> = [];
  for (const sector of SUPPLIER_SECTORS) {
    try {
      const r = await runPairingScout(businessId, sector, perSector);
      results.push({ sector, created: r.created });
    } catch (e) {
      console.error(`sector "${sector}" failed:`, e instanceof Error ? e.message : e);
      results.push({ sector, created: 0 });
    }
  }
  return results;
}

export const pairingScout = agent;
