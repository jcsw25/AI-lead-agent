import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";

/**
 * COMPANY CLASSIFIER
 *
 * Given one company, work out what it actually does, which side of the market
 * it sits on, and which pairings it belongs to.
 *
 * Note the mock is NOT a placeholder here — it runs real token-overlap matching
 * against the pairing library. Without an API key you still get usable
 * suggestions, just blunter ones: it matches on vocabulary rather than
 * understanding. That matters because this is the screen someone will use
 * before they have decided to pay for a key.
 */

const Input = z.object({
  companyName: z.string(),
  domain: z.string().optional(),
  description: z.string(),
  corpus: z.string(),
  candidateIndustries: z.array(z.string()),
});

const Output = z.object({
  industry: z.string(),
  whatTheySell: z.string(),
  /** SUPPLIER = has capability to sell. BUYER = has a need. BOTH is common. */
  side: z.enum(["SUPPLIER", "BUYER", "BOTH"]),
  sizeGuess: z.string().optional(),
  /** Industries from the candidate list this company plausibly belongs to. */
  matchedIndustries: z.array(z.string()),
  /** What they could offer others, and what others could offer them. */
  couldProvide: z.array(z.string()),
  couldNeed: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const SYSTEM = `You classify a company from its own website text.

- industry: the specific trade, not a category. "Commercial laundry and linen services",
  not "Services".
- side: SUPPLIER if it has a capability it sells to other businesses. BUYER if it mainly
  consumes services. BOTH when it is genuinely both — most SMEs are.
- matchedIndustries: pick only from the supplied candidate list, and only where the fit is
  real. An empty array is a valid and useful answer.
- couldProvide / couldNeed: concrete. "Quarterly servicing contracts for building
  managers", not "quality service".
- Set confidence low when the site is thin marketing copy with no substance, and say so in
  reasoning. Most SME sites are exactly that.
- Do not invent headcount, revenue or clients. If the site does not say it, you do not
  know it.`;

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "COMPANY_RESEARCH",
  model: "claude-sonnet-5",
  effort: "medium",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) => `Company: ${i.companyName}${i.domain ? ` (${i.domain})` : ""}
Site description: ${i.description || "(none)"}

Site text:
${i.corpus.slice(0, 6000)}

Candidate industries (choose only from these for matchedIndustries):
${i.candidateIndustries.map((c) => `- ${c}`).join("\n")}`,
  mock: (i) => {
    // Real token-overlap matching, not a stub.
    const STOP = new Set(["and", "the", "for", "with", "services", "service", "companies", "company", "singapore", "our", "your", "from", "that", "this", "they", "their"]);
    const tokens = (s: string) =>
      new Set(s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));

    const text = tokens(`${i.companyName} ${i.description} ${i.corpus.slice(0, 4000)}`);
    const scored = i.candidateIndustries
      .map((ind) => {
        const t = tokens(ind);
        let hits = 0;
        for (const w of t) if (text.has(w)) hits++;
        return { ind, score: t.size ? hits / t.size : 0, hits };
      })
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 5);
    return {
      industry: top[0]?.ind ?? "Unclassified",
      whatTheySell: i.description || i.corpus.slice(0, 200) || "Not stated on the site.",
      side: "BOTH" as const,
      matchedIndustries: top.map((t) => t.ind),
      couldProvide: top.slice(0, 2).map((t) => `Capability associated with ${t.ind.toLowerCase()}`),
      couldNeed: [],
      confidence: top.length ? Math.min(0.4, top[0].score) : 0.1,
      reasoning:
        `Matched by keyword overlap against ${i.candidateIndustries.length} known industries — ` +
        `no model was called, so this is vocabulary matching rather than understanding. ` +
        `Top match shared ${top[0]?.hits ?? 0} terms. Add ANTHROPIC_API_KEY for real classification.`,
    };
  },
};

export type CounterpartSuggestion = {
  pairingId: string;
  ourSide: "A" | "B";
  ourIndustry: string;
  theirIndustry: string;
  whatWeOffer: string;
  whyTheyNeedIt: string;
  trigger: string;
  timingWindow: string | null;
  commissionRate: number | null;
  dealLow: number | null;
  dealHigh: number | null;
  /** Companies already in the database on the other side. */
  knownCounterparts: Array<{ id: string; name: string; domain: string | null; phone: string | null; email: string | null }>;
};

/**
 * Classify a company, then find who to link it with — in both directions.
 * A laundry is a supplier to hotels AND a buyer of pest control.
 */
export async function classifyAndLink(businessId: string, companyId: string) {
  const company = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { contacts: true },
  });

  const pairings = await db.pairing.findMany({ where: { businessId }, orderBy: { score: "desc" } });
  const industries = [...new Set(pairings.flatMap((p) => [p.supplierIndustry, p.buyerIndustry]))];

  const corpus = [company.description, ...company.contacts.map((c) => c.jobTitle)].filter(Boolean).join(" ");

  const { output, runId, simulated } = await runAgent(
    agent,
    {
      companyName: company.name,
      domain: company.primaryDomain ?? undefined,
      description: company.description ?? "",
      corpus,
      candidateIndustries: industries.slice(0, 140),
    },
    { businessId },
  );

  const matched = new Set(output.matchedIndustries.map((m) => m.toLowerCase()));
  const suggestions: CounterpartSuggestion[] = [];

  for (const p of pairings) {
    const isA = matched.has(p.supplierIndustry.toLowerCase());
    const isB = matched.has(p.buyerIndustry.toLowerCase());
    if (!isA && !isB) continue;

    const theirIndustry = isA ? p.buyerIndustry : p.supplierIndustry;
    const known = await db.company.findMany({
      where: { industry: { contains: theirIndustry.split(/[ ,]/)[0], mode: "insensitive" }, id: { not: companyId } },
      include: { contacts: { take: 1 } },
      take: 6,
    });

    suggestions.push({
      pairingId: p.id,
      ourSide: isA ? "A" : "B",
      ourIndustry: isA ? p.supplierIndustry : p.buyerIndustry,
      theirIndustry,
      whatWeOffer: isA ? p.whatAHas : p.whatBNeeds,
      whyTheyNeedIt: isA ? p.whatBNeeds : p.whatAHas,
      trigger: p.trigger,
      timingWindow: p.timingWindow,
      commissionRate: p.commissionRate ? Number(p.commissionRate) : null,
      dealLow: p.typicalDealLow ? Number(p.typicalDealLow) : null,
      dealHigh: p.typicalDealHigh ? Number(p.typicalDealHigh) : null,
      knownCounterparts: known.map((k) => ({
        id: k.id,
        name: k.name,
        domain: k.primaryDomain,
        phone: k.contacts[0]?.phone ?? null,
        email: k.contacts[0]?.email ?? null,
      })),
    });
  }

  // Persist what we learned about the company itself.
  await db.company.update({
    where: { id: companyId },
    data: { industry: output.industry !== "Unclassified" ? output.industry : company.industry },
  });

  return { classification: output, suggestions, runId, simulated };
}

export const companyClassifier = agent;
