import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";

/**
 * MATCHMAKER SCOUT
 *
 * Looks at the companies actually in the database and argues for specific pairs
 * who should meet.
 *
 * This runs in the opposite direction to the pairing engine. That one writes an
 * industry-level thesis ("aircon servicing → dental clinic") and applies it
 * mechanically to every company on each side; it is deterministic, cheap, and
 * incapable of surprise. This one reads two real companies and makes the case
 * for THAT pair — which is where the non-obvious combinations come from, and
 * non-obvious is where a broker is worth a fee. Anyone can introduce a caterer
 * to an office.
 *
 * The binding constraint is that value must flow BOTH ways. A one-sided match
 * is a sales lead with better manners: the buyer gains and the seller pays,
 * which is a transaction, not an introduction. Two-sided value is what makes
 * both parties glad you called, and it is the only reason either of them takes
 * the next one.
 */

const Input = z.object({
  region: z.string(),
  brokerBusiness: z.string(),
  /** Real companies, with whatever has been verified about each. */
  companies: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      industry: z.string().nullable(),
      description: z.string().nullable(),
      /** Measured weaknesses on their own website. */
      observed: z.array(z.string()),
      hasEmail: z.boolean(),
    }),
  ),
  /** Pairs already proposed, so each run explores rather than repeats. */
  alreadyProposed: z.array(z.string()).default([]),
});

const Proposal = z.object({
  /** Must be an id from the supplied list. */
  companyAId: z.string(),
  companyBId: z.string(),
  valueToA: z.string(),
  valueToB: z.string(),
  pitch: z.string(),
  whyNow: z.string().nullable(),
  /** 0 = anyone would think of this. 1 = nobody would. */
  novelty: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  /** Facts from the supplied data that this rests on. */
  groundedOn: z.array(z.string()),
  /** What was assumed rather than known. */
  assumptions: z.array(z.string()),
  estimatedValue: z.number().nullable(),
  commissionRate: z.number().nullable(),
});

const Output = z.object({
  proposals: z.array(Proposal).min(1).max(10),
  notes: z.string(),
});

const SYSTEM = `You are a broker looking at a list of real companies, deciding which two should
meet.

For each pair you propose, you must be able to say what EACH side gets. Not "more business" —
something specific enough that the company would recognise it as true about their own
situation.

WHY BOTH SIDES MATTER

A one-sided match is a sales lead. One party gains, the other pays, and the broker is just
a middleman taking a cut of somebody's marketing. That works once. Two-sided value is what
makes both parties glad you called, and it is the only reason either of them picks up when
you introduce the next one.

So: if you cannot articulate what the SELLER gains beyond revenue, and what the BUYER gains
beyond a service they could have found themselves, the pair is not worth proposing. Say so
by proposing fewer.

WHAT MAKES A PAIR WORTH A FEE

Anyone can introduce a caterer to an office. Nobody pays for that. The pairs worth making
are the ones where:

- one side has spare capacity in exactly the window the other side is under pressure
- one side's customers are the other side's ideal customers, and neither has noticed
- one side has a measured weakness the other side fixes as its ordinary work
- both serve the same buyer at different moments, so each can refer the other
- a seasonal peak for one is a trough for the other, so the relationship works year-round
- one side needs something small and constant that the other already does at scale

RULES

1. Use ONLY companies from the supplied list, and use their exact ids.
2. Ground every factual claim in the supplied description or observed findings. List them
   in groundedOn. Anything you are inferring goes in assumptions, honestly — an
   assumption is fine, an assumption disguised as a fact is not.
3. novelty is how unlikely the pair is, NOT how good it is. A boring pair that clearly
   works should have high confidence and low novelty. Do not inflate novelty to seem
   clever; a fabricated connection is worse than an obvious one.
4. confidence should be LOW when you are reasoning from industry alone with nothing
   verified about the specific company. Most of these will be 0.3-0.5. That is correct.
5. whyNow must be something that happens on its own — a date, a season, a published fact.
   If there is no real timing reason, return null rather than inventing urgency.
6. The pitch is one or two sentences you would actually say on a call. Plain language.
7. Do not propose a company to itself, and do not repeat a pair listed as already proposed.
8. Prefer pairs where at least one side has a contactable email; an unreachable company
   cannot be introduced to anyone.

Between four and eight proposals. Fewer good ones beats a full list padded with reaches.`;

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "MATCHMAKER",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) =>
    `Region: ${i.region}. Broker: ${i.brokerBusiness}.\n\n` +
    `COMPANIES (use these ids exactly):\n` +
    i.companies
      .map(
        (c) =>
          `- ${c.id} | ${c.name} | ${c.industry ?? "unclassified"}${c.hasEmail ? " | contactable" : " | no email"}\n` +
          `    ${c.description ? c.description.replace(/\s+/g, " ").slice(0, 220) : "(no description on file)"}` +
          (c.observed.length ? `\n    observed on their site: ${c.observed.slice(0, 2).join("; ")}` : ""),
      )
      .join("\n") +
    (i.alreadyProposed.length
      ? `\n\nAlready proposed — do not repeat:\n${i.alreadyProposed.map((p) => `- ${p}`).join("\n")}`
      : ""),
  mock: () => ({
    proposals: [],
    notes: "No ANTHROPIC_API_KEY set, so no matches were proposed.",
  }),
};

export type ScoutResult = { created: number; skipped: number; notes: string };

export async function runMatchmakerScout(
  businessId: string,
  opts: { sampleSize?: number } = {},
): Promise<ScoutResult> {
  const sampleSize = opts.sampleSize ?? 40;

  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { region: true },
  });

  // Only companies that passed qualification — proposing a match involving a
  // directory or a rejected entry wastes the call and the reader's trust.
  const rows = await db.company.findMany({
    where: {
      qualifications: { some: { businessId, status: { not: "REJECTED" } } },
    },
    select: {
      id: true, name: true, industry: true, description: true,
      contacts: { select: { email: true } },
      siteAudit: { select: { findings: true } },
      qualifications: { where: { businessId }, select: { score: true }, take: 1 },
    },
    take: 400,
  });

  // Spread the sample across industries. Taking the top N by score would hand
  // the model forty aircon companies and produce forty aircon matches.
  const byIndustry = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = r.industry ?? "unclassified";
    byIndustry.set(k, [...(byIndustry.get(k) ?? []), r]);
  }
  const sample: typeof rows = [];
  const perIndustry = Math.max(2, Math.ceil(sampleSize / Math.max(1, byIndustry.size)));
  for (const [, list] of byIndustry) {
    sample.push(
      ...list
        .sort((a, b) => (b.qualifications[0]?.score ?? 0) - (a.qualifications[0]?.score ?? 0))
        .slice(0, perIndustry),
    );
  }

  if (sample.length < 2) return { created: 0, skipped: 0, notes: "Not enough qualified companies to match." };

  const existing = await db.matchmake.findMany({
    where: { businessId },
    include: { companyA: { select: { name: true } }, companyB: { select: { name: true } } },
    take: 60,
  });

  const run = await runAgent(
    agent,
    {
      region: business.region.name,
      brokerBusiness: business.name,
      companies: sample.slice(0, sampleSize).map((c) => ({
        id: c.id,
        name: c.name,
        industry: c.industry,
        description: c.description,
        observed: ((c.siteAudit?.findings as string[] | null) ?? []).slice(0, 2),
        hasEmail: c.contacts.some((x) => x.email),
      })),
      alreadyProposed: existing.map((e) => `${e.companyA.name} + ${e.companyB.name}`),
    },
    { businessId },
  );

  const valid = new Set(sample.map((s) => s.id));
  let created = 0;
  let skipped = 0;

  for (const p of run.output.proposals) {
    // The model must use real ids. A hallucinated one is silently dropped
    // rather than stored as a match to a company that does not exist.
    if (!valid.has(p.companyAId) || !valid.has(p.companyBId) || p.companyAId === p.companyBId) {
      skipped++;
      continue;
    }
    const rate = p.commissionRate ?? 0.1;
    const value = p.estimatedValue ?? null;
    try {
      await db.matchmake.upsert({
        where: { businessId_companyAId_companyBId: { businessId, companyAId: p.companyAId, companyBId: p.companyBId } },
        create: {
          businessId, companyAId: p.companyAId, companyBId: p.companyBId,
          valueToA: p.valueToA, valueToB: p.valueToB, pitch: p.pitch, whyNow: p.whyNow,
          novelty: p.novelty, confidence: p.confidence,
          groundedOn: p.groundedOn as object, assumptions: p.assumptions as object,
          estimatedValue: value, commissionRate: rate,
          estimatedCommission: value ? Number((value * rate).toFixed(2)) : null,
          agentRunId: run.runId,
        },
        update: {
          valueToA: p.valueToA, valueToB: p.valueToB, pitch: p.pitch, whyNow: p.whyNow,
          novelty: p.novelty, confidence: p.confidence,
          groundedOn: p.groundedOn as object, assumptions: p.assumptions as object,
        },
      });
      created++;
    } catch {
      skipped++;
    }
  }

  return { created, skipped, notes: run.output.notes };
}
