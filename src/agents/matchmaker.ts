import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";

/**
 * MATCHMAKER
 *
 * Picks which supplier product to put in front of which buyer, and why. This is
 * the brokerage core: the supplier may be the tenant's own catalogue (isSelf)
 * or a third party we introduce for a commission. Same code path either way.
 *
 * Per ADR-002 the model supplies judgment (fit features, deal size reasoning)
 * and code does the arithmetic - fit score and commission are both computed.
 */

const Suggestion = z.object({
  productId: z.string(),
  /** Judgment features, 0..1 each. The composite is computed, not asked for. */
  needFit: z.number().min(0).max(1),
  budgetFit: z.number().min(0).max(1),
  timingFit: z.number().min(0).max(1),
  rationale: z.string(),
  angle: z.string(),
  estimatedDealValue: z.number().optional(),
  estimatedUnits: z.number().optional(),
  /** Services only: the symptom you actually observed, and the first ask. */
  observedPain: z.string().optional(),
  firstAsk: z.string().optional(),
});

const Input = z.object({
  companyName: z.string(),
  companyDescription: z.string(),
  employeeBand: z.string().optional(),
  industry: z.string(),
  whyItFits: z.string(),
  buyingTrigger: z.string(),
  timingWindow: z.string().optional(),
  currency: z.string(),
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      priceMin: z.number().nullable(),
      priceMax: z.number().nullable(),
      minOrderQty: z.number().nullable(),
      idealFor: z.array(z.string()),
      kind: z.enum(["PRODUCT", "SERVICE"]),
      rateType: z.string(),
      typicalEngagementDays: z.number().nullable(),
      skills: z.array(z.string()),
      painSignals: z.array(z.string()),
      supplierName: z.string(),
      isOwnProduct: z.boolean(),
    }),
  ),
});

const Output = z.object({
  suggestions: z.array(Suggestion),
  /** Say so when nothing genuinely fits, rather than forcing a match. */
  noGoodFit: z.boolean(),
  reasoning: z.string(),
});

const SYSTEM = `You match a buyer to the single best product to pitch them, from a supplied catalogue.

Rules:
- Return at most 2 suggestions, best first. One strong match beats three weak ones.
- Only suggest products from the supplied catalogue. Never invent one.
- estimatedDealValue must be arithmetic you can show: unit price x a plausible quantity
  for a company of this size. If you cannot justify a number, omit it.
- budgetFit reflects whether this company can plausibly afford the minimum order, given
  its size. A great product they cannot buy at minimum quantity is a poor match.
- timingFit reflects the buying trigger and window, not general enthusiasm.
- rationale must reference something specific about THIS company. If all you can say is
  generic industry logic, score needFit low and say so.
- If nothing in the catalogue genuinely fits, set noGoodFit true and return no suggestions.
  A forced match wastes an outreach slot and burns the relationship.

SERVICES are different from products and must be handled differently:
- You cannot match a service on industry fit. Match it on OBSERVABLE PAIN - a symptom
  visible from outside the company: hiring ads for repetitive roles, legacy technology
  named in job postings, disconnected systems, manual reconciliation, a long-open
  engineering vacancy. Each service lists painSignals; find evidence of one.
- Set observedPain to the specific symptom you actually saw. If you cannot name one,
  score needFit low - a service pitched with no evidence of pain is a cold guess.
- estimatedDealValue for a service is the ENGAGEMENT value (day rate x days, or the
  project fee), not a unit price. Start at the low end of the range: you are estimating
  before scoping, and an inflated first number kills the call.
- firstAsk for a service is a diagnostic conversation, never a purchase. Nobody buys
  engineering from a cold email. The realistic ask is a short call to confirm the
  problem, and the cheapest entry point in the catalogue (an audit) if one exists.`;

/** Composite fit. Deterministic - same inputs, same score, always. */
export function fitScore(s: { needFit: number; budgetFit: number; timingFit: number }): number {
  return Number((s.needFit * 0.45 + s.budgetFit * 0.3 + s.timingFit * 0.25).toFixed(3));
}

/** Commission is arithmetic over the supplier's terms, never model output. */
export function commissionFor(
  model: "PERCENT" | "FLAT" | "MARKUP" | "NONE",
  rate: number | null,
  dealValue: number | null,
): number | null {
  if (!rate) return null;
  if (model === "FLAT") return rate;
  if (model === "NONE") return null;
  if (!dealValue) return null;
  return Number(((dealValue * rate) / 100).toFixed(2));
}

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "MATCHMAKER",
  model: "claude-sonnet-5",
  effort: "medium",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) => `Buyer: ${i.companyName}
Industry: ${i.industry}${i.employeeBand ? ` · ${i.employeeBand} employees` : ""}
About: ${i.companyDescription}
Why we targeted them: ${i.whyItFits}
Buying trigger: ${i.buyingTrigger}${i.timingWindow ? `\nWindow: ${i.timingWindow}` : ""}

Catalogue (${i.currency}):
${i.products
  .map(
    (p) =>
      p.kind === "SERVICE"
        ? `- [${p.id}] SERVICE: ${p.name} — ${p.supplierName} (partner); ${p.priceMin ?? "?"}–${p.priceMax ?? "?"} ${p.rateType}; skills: ${p.skills.join(", ")}; look for: ${p.painSignals.join("; ")}${p.description ? `; ${p.description}` : ""}`
        : `- [${p.id}] PRODUCT: ${p.name} — ${p.supplierName}${p.isOwnProduct ? " (our own)" : " (partner)"}; ${p.priceMin ?? "?"}–${p.priceMax ?? "?"} per unit${p.minOrderQty ? `, min ${p.minOrderQty}` : ""}; suits: ${p.idealFor.join(", ") || "unspecified"}${p.description ? `; ${p.description}` : ""}`,
  )
  .join("\n")}`,
  mock: (i) => {
    // Prefer products whose idealFor tags overlap the buyer's industry, then
    // rotate deterministically by company name. Without the rotation every
    // company matches the same product and the brokerage path never shows.
    const words = i.industry.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
    const relevant = i.products.filter((p) =>
      p.idealFor.some((t) => words.some((w) => t.toLowerCase().includes(w) || w.includes(t.toLowerCase()))),
    );
    const pool = relevant.length ? relevant : i.products;
    const h = [...i.companyName].reduce((a, c) => a + c.charCodeAt(0), 0);
    const pick = pool[h % pool.length];
    if (!pick) return { suggestions: [], noGoodFit: true, reasoning: "Catalogue is empty." };

    const isService = pick.kind === "SERVICE";
    // A service deal is the engagement, not unit x quantity. Anchor low —
    // this is an estimate made before any scoping conversation.
    // A day rate is not a deal value. Multiply by the typical engagement, or
    // the whole pipeline reads as one day's work.
    const dealValue = isService
      ? pick.rateType === "DAY_RATE" || pick.rateType === "HOURLY"
        ? (pick.priceMin ?? 1000) * (pick.typicalEngagementDays ?? 20)
        : pick.rateType === "RETAINER"
          ? (pick.priceMin ?? 3000) * 6
          : (pick.priceMin ?? 5000)
      : (pick.priceMax ?? pick.priceMin ?? 100) * (pick.minOrderQty ?? 50);

    return {
      suggestions: [
        {
          productId: pick.id,
          needFit: isService ? 0.6 : 0.7,
          budgetFit: 0.6,
          timingFit: isService ? 0.5 : 0.65,
          rationale: isService
            ? `Simulated match. ${pick.name} would address pain like "${pick.painSignals[0] ?? "manual process load"}" at ${i.companyName}. No research ran, so no pain was actually observed.`
            : `Simulated match. ${pick.name} is the closest catalogue fit for ${i.companyName} given the trigger "${i.buyingTrigger}". No research was performed.`,
          angle: isService ? "operational_pain" : "seasonal_trigger",
          estimatedDealValue: dealValue,
          estimatedUnits: isService ? undefined : (pick.minOrderQty ?? 50),
          observedPain: isService ? `${pick.painSignals[0] ?? "manual process load"} (simulated — unobserved)` : undefined,
          firstAsk: isService ? "A 20-minute call to confirm where the manual load actually sits" : undefined,
        },
      ],
      noGoodFit: false,
      reasoning: `Simulated — selected a ${isService ? "service" : "product"} to demonstrate the flow.`,
    };
  },
};

export async function runMatchmaker(businessId: string, prospectId: string) {
  const prospect = await db.prospect.findUniqueOrThrow({
    where: { id: prospectId },
    include: { company: true, play: true, business: { include: { region: true } } },
  });

  const products = await db.supplierProduct.findMany({
    where: { isActive: true, supplier: { businessId, isActive: true } },
    include: { supplier: true },
  });
  if (!products.length) return { created: 0, noGoodFit: true, simulated: false };

  const { output, runId, simulated } = await runAgent(
    agent,
    {
      companyName: prospect.company.name,
      companyDescription: prospect.company.description ?? "No description recorded.",
      employeeBand: prospect.company.employeeBand ?? undefined,
      industry: prospect.company.industry ?? prospect.play?.industry ?? "unknown",
      whyItFits: prospect.play?.thesis ?? "Manually added prospect.",
      buyingTrigger: prospect.play?.buyingTrigger ?? "No trigger recorded.",
      timingWindow: prospect.play?.timingWindow ?? undefined,
      currency: prospect.business.region.currency,
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? undefined,
        priceMin: p.priceMin ? Number(p.priceMin) : null,
        priceMax: p.priceMax ? Number(p.priceMax) : null,
        minOrderQty: p.minOrderQty,
        idealFor: p.idealFor,
        kind: p.kind,
        rateType: p.rateType,
        typicalEngagementDays: p.typicalEngagementDays,
        skills: p.skills,
        painSignals: p.painSignals,
        supplierName: p.supplier.name,
        isOwnProduct: p.supplier.isSelf,
      })),
    },
    { businessId },
  );

  let created = 0;
  for (const s of output.suggestions) {
    const product = products.find((p) => p.id === s.productId);
    if (!product) continue; // model named a product that isn't in the catalogue

    const dealValue = s.estimatedDealValue ?? null;
    const model = product.supplier.isSelf ? "NONE" : product.supplier.defaultCommissionModel;
    const rate = product.supplier.defaultCommissionRate ? Number(product.supplier.defaultCommissionRate) : null;

    await db.match.upsert({
      where: { prospectId_supplierProductId: { prospectId, supplierProductId: product.id } },
      update: { fitScore: fitScore(s), rationale: s.rationale, angle: s.angle, observedPain: s.observedPain ?? null, firstAsk: s.firstAsk ?? null },
      create: {
        businessId,
        prospectId,
        supplierProductId: product.id,
        fitScore: fitScore(s),
        rationale: s.rationale,
        angle: s.angle,
        observedPain: s.observedPain ?? null,
        firstAsk: s.firstAsk ?? null,
        estimatedDealValue: dealValue,
        commissionModel: model,
        commissionRate: rate,
        estimatedCommission: commissionFor(model, rate, dealValue),
        currency: product.currency,
        agentRunId: runId,
      },
    });
    created++;
  }

  if (created) {
    await db.prospect.update({ where: { id: prospectId }, data: { stage: "QUALIFIED" } });
    await db.activity.create({
      data: { prospectId, type: "matched", summary: `Matched to ${created} product(s). ${output.reasoning}` },
    });
  }

  return { created, noGoodFit: output.noGoodFit, simulated };
}

export const matchmaker = agent;
