import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";

/**
 * PAIRING GENERATOR
 *
 * Produces A→B theses keyed to the industries that are actually in the
 * database.
 *
 * The existing pairing library has 69 rows and covers none of them. It was
 * written against descriptive phrases — "Commercial laundry and linen services",
 * "Boutique hotels, spas and resorts" — while discovery stores what was
 * searched: "aircon servicing", "dental clinic". Nothing matched, so 181
 * contactable companies were rejected with NO_PAIRING_THESIS: the single
 * largest rejection reason in the database. A thesis that does not key to a
 * real industry string is a thesis nobody can act on.
 *
 * The highest-value output is a pairing where BOTH sides already exist here,
 * because that becomes a company-level introduction immediately rather than
 * another industry to go and scrape.
 */

const Input = z.object({
  region: z.string(),
  /** Industries in the database, with how many companies each holds. */
  present: z.array(z.object({ industry: z.string(), companies: z.number(), withEmail: z.number() })),
  /** Weaknesses measured across their websites — real openings, not guesses. */
  observedWeaknesses: z.array(z.object({ finding: z.string(), companies: z.number() })),
  avoid: z.array(z.string()).default([]),
});

const PairingItem = z.object({
  /** MUST be copied verbatim from the present[] list, or from a new industry. */
  supplierIndustry: z.string(),
  buyerIndustry: z.string(),
  /** True when both sides appear in present[] — actionable today. */
  bothSidesPresent: z.boolean(),
  lane: z.enum(["DIRECT", "ADJACENT", "SEASONAL", "TRIGGER", "CHANNEL", "CONTRARIAN"]),
  whatAHas: z.string(),
  whatBNeeds: z.string(),
  trigger: z.string(),
  timingWindow: z.string().nullable(),
  reachA: z.array(z.string()),
  reachB: z.array(z.string()),
  typicalDealLow: z.number(),
  typicalDealHigh: z.number(),
  commissionRate: z.number(),
  demandStrength: z.number().min(0).max(1),
  supplyEase: z.number().min(0).max(1),
  competition: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const Output = z.object({
  pairings: z.array(PairingItem).min(4).max(16),
  notes: z.string(),
});

const SYSTEM = `You design brokered introductions between two businesses.

The person using this is a middleman. They recruit business A, which has something
to sell, then find business B, which needs it, introduce the two, and take a
percentage of what closes. Both sides have to be real, reachable companies — not
market segments.

You are given the industries actually sitting in their database, with counts. Your
job is to find the A→B pairs worth making.

RULES THAT DECIDE WHETHER THIS IS USABLE:

1. COPY INDUSTRY NAMES VERBATIM. When you use an industry from the present[] list,
   reproduce the string exactly — "aircon servicing", not "Aircon Servicing" or
   "air conditioning services". These strings are database keys. A near-miss is a
   miss, and the pairing silently matches nothing.

2. PRIORITISE PAIRS WHERE BOTH SIDES ARE PRESENT. A pairing between two industries
   already in the database can become a real introduction today. One that needs a
   new industry scraped first is worth less, however elegant. Set bothSidesPresent
   truthfully — it is checked.

3. THE TRIGGER MUST BE SOMETHING THAT ALREADY HAPPENED, or a date that arrives on
   its own. "They have an office" is not a trigger. "Their aircon has not been
   serviced since the last fiscal year" is not one either unless you can observe
   it. Seasonal dates, regulatory deadlines, and MEASURED WEAKNESSES are triggers.
   The observedWeaknesses list is real data from their websites — use it.

4. BE SPECIFIC ABOUT MONEY. typicalDealLow/High in the local currency for one
   transaction, not annual contract value. commissionRate as a decimal (0.1 = 10%).
   A broker who cannot say what a deal is worth cannot decide who to call.

5. reachA / reachB are job titles to ask for. In an SME market where nobody
   publishes staff names, "whoever answers the main line" and "owner" are honest
   answers. Do not invent corporate hierarchies that do not exist in a 12-person firm.

6. LANES: DIRECT (obvious need), ADJACENT (a capability they also sell),
   SEASONAL (a date drives it), TRIGGER (an event drives it), CHANNEL (A sells
   through B to B's customers), CONTRARIAN (a pairing nobody is making).
   Vary them. Six DIRECT pairings is a failure of imagination.

7. Set confidence low and say so in reasoning when you are guessing about the
   local market. An honest 0.4 is more useful than a confident 0.8 that is wrong.`;

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "PAIRING_SCOUT",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) =>
    `Region: ${i.region}\n\n` +
    `Industries already in the database (copy these strings EXACTLY):\n` +
    i.present.map((p) => `- "${p.industry}" — ${p.companies} companies, ${p.withEmail} with an email`).join("\n") +
    `\n\nWeaknesses measured across their websites:\n` +
    i.observedWeaknesses.map((w) => `- ${w.finding}: ${w.companies} companies`).join("\n") +
    (i.avoid.length ? `\n\nAlready in the library, do not repeat:\n${i.avoid.map((a) => `- ${a}`).join("\n")}` : ""),
  mock: (i) => ({
    pairings: [],
    notes:
      `No ANTHROPIC_API_KEY set, so no pairings were generated. ` +
      `${i.present.length} industries are waiting for theses.`,
  }),
};

/** Composite score. Arithmetic, not model-assigned — ADR-002 applies here too. */
export function pairingScore(p: {
  demandStrength: number; supplyEase: number; competition: number; confidence: number;
  bothSidesPresent?: boolean;
}): number {
  const base =
    p.demandStrength * 0.35 +
    p.supplyEase * 0.2 +
    (1 - p.competition) * 0.2 +
    p.confidence * 0.25;
  // A pairing we can act on today is worth more than one that needs a scrape first.
  return Number(Math.min(1, base * (p.bothSidesPresent ? 1.15 : 1)).toFixed(3));
}

export type GenerateResult = {
  created: number;
  updated: number;
  bothSides: number;
  notes: string;
  runId: string | null;
};

export async function generatePairingsForDatabase(
  businessId: string,
  opts: { minCompanies?: number } = {},
): Promise<GenerateResult> {
  const minCompanies = opts.minCompanies ?? 1;

  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { region: true },
  });

  // What we actually hold, so the model keys its output to real strings.
  const companies = await db.company.findMany({
    select: { industry: true, contacts: { select: { email: true } } },
  });
  const byIndustry = new Map<string, { companies: number; withEmail: number }>();
  for (const c of companies) {
    if (!c.industry) continue;
    const e = byIndustry.get(c.industry) ?? { companies: 0, withEmail: 0 };
    e.companies++;
    if (c.contacts.some((x) => x.email)) e.withEmail++;
    byIndustry.set(c.industry, e);
  }
  const present = [...byIndustry.entries()]
    .filter(([, v]) => v.companies >= minCompanies)
    .map(([industry, v]) => ({ industry, ...v }))
    .sort((a, b) => b.companies - a.companies);

  // Measured weaknesses — these are the honest triggers.
  const audits = await db.siteAudit.findMany({ where: { reachable: true }, select: { findings: true } });
  const freq = new Map<string, number>();
  for (const a of audits) {
    for (const f of ((a.findings as string[] | null) ?? [])) {
      const key = f.split("—")[0].trim();
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  const observedWeaknesses = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([finding, companies]) => ({ finding, companies }));

  const existing = await db.pairing.findMany({
    where: { businessId },
    select: { supplierIndustry: true, buyerIndustry: true },
  });
  const avoid = existing.map((e) => `${e.supplierIndustry} -> ${e.buyerIndustry}`);

  const run = await runAgent(
    agent,
    { region: business.region.name, present, observedWeaknesses, avoid },
    { businessId },
  );

  const presentSet = new Set(present.map((p) => p.industry.toLowerCase()));
  let created = 0;
  let updated = 0;
  let bothSides = 0;

  for (const p of run.output.pairings) {
    // Trust but verify: the flag decides how the pairing is ranked, so it is
    // recomputed here rather than taken on faith.
    const actuallyBoth =
      presentSet.has(p.supplierIndustry.toLowerCase()) && presentSet.has(p.buyerIndustry.toLowerCase());
    if (actuallyBoth) bothSides++;

    const score = pairingScore({ ...p, bothSidesPresent: actuallyBoth });

    const dupe = await db.pairing.findFirst({
      where: {
        businessId,
        supplierIndustry: { equals: p.supplierIndustry, mode: "insensitive" },
        buyerIndustry: { equals: p.buyerIndustry, mode: "insensitive" },
      },
      select: { id: true },
    });

    const data = {
      supplierIndustry: p.supplierIndustry,
      buyerIndustry: p.buyerIndustry,
      lane: p.lane,
      whatAHas: p.whatAHas,
      whatBNeeds: p.whatBNeeds,
      trigger: p.trigger,
      timingWindow: p.timingWindow,
      reachA: p.reachA,
      reachB: p.reachB,
      typicalDealLow: p.typicalDealLow,
      typicalDealHigh: p.typicalDealHigh,
      commissionRate: p.commissionRate,
      demandStrength: p.demandStrength,
      supplyEase: p.supplyEase,
      competition: p.competition,
      confidence: p.confidence,
      score,
      status: "active",
      agentRunId: run.runId,
      evidence: { bothSidesPresent: actuallyBoth, reasoning: p.reasoning } as object,
    };

    if (dupe) {
      await db.pairing.update({ where: { id: dupe.id }, data });
      updated++;
    } else {
      await db.pairing.create({ data: { businessId, ...data } });
      created++;
    }
  }

  return { created, updated, bothSides, notes: run.output.notes, runId: run.runId };
}
