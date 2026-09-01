import { db } from "@/lib/db";
import type { CompanyFeatures, Feature } from "./features";

/**
 * The scorer.
 *
 * Weights live in the ScoringModel table rather than in this file, so they can
 * be refitted from outcomes without a deploy and so an old score stays
 * reproducible — you can always ask "which weights produced this 82?".
 *
 * The arithmetic is deliberately boring: normalised feature x weight, summed,
 * scaled to 0-100. There is no model call anywhere in this path. That is what
 * makes a score explainable line by line, cheap enough to recompute for every
 * company whenever the weights change, and impossible to hallucinate.
 */

export type ScoredFactor = {
  factor: string;
  rawValue: number;
  weight: number;
  contribution: number;
  evidence: string;
};

export type ScoreResult = {
  score: number;
  tier: "HOT" | "WARM" | "COLD";
  grade: "A" | "B" | "C" | "D";
  factors: ScoredFactor[];
  explanation: string;
  modelId: string;
  modelVersion: number;
};

/**
 * The starting weights.
 *
 * These are a prior, not a finding — nobody has sent an email yet, so there are
 * no outcomes to fit against. They encode one deliberate judgement: for a
 * broker, being able to REACH someone matters more than anything else, because
 * an unreachable company is worth exactly zero regardless of how good a fit it
 * is. Refit these from OutcomeStat once there are enough replies to mean
 * something (see docs/10-intelligence-plan.md, phase 5).
 */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  contactability: 0.30,
  pairingFit: 0.20,
  improvableSite: 0.15,
  evidenceDepth: 0.12,
  verified: 0.10,
  siteQuality: 0.08,
  freshness: 0.05,
};

/** The feature vocabulary this scorer understands. */
export const FEATURE_KEYS = Object.keys(DEFAULT_WEIGHTS);

/**
 * Fetch the active model, creating or superseding it as needed.
 *
 * The supersede path exists because it already bit once: the seeded v1 model
 * carried the weight names from the original architecture document
 * ("signalStrength", "companySize", "timing") while the features this scorer
 * computes are named differently. Nothing errored — every weight simply matched
 * no feature, so all 435 companies scored 0 and graded D. A weights blob that
 * shares no keys with the feature vocabulary is not a valid model, and silently
 * scoring everything zero is the worst possible way to say so.
 */
export async function activeScoringModel(businessId: string) {
  const existing = await db.scoringModel.findFirst({
    where: { OR: [{ businessId }, { businessId: null }], isActive: true },
    orderBy: [{ businessId: "desc" }, { version: "desc" }],
  });

  if (existing) {
    const keys = Object.keys((existing.weights as Record<string, number>) ?? {});
    const overlap = keys.filter((k) => FEATURE_KEYS.includes(k)).length;
    if (overlap > 0) return existing;
    // Retire it rather than deleting: old ScoreSnapshots point at it.
    await db.scoringModel.update({ where: { id: existing.id }, data: { isActive: false } });
    console.warn(
      `[scoring] model v${existing.version} has no weights matching the feature set ` +
        `(${keys.join(", ")}) — superseding it.`,
    );
  }

  const latest = await db.scoringModel.findFirst({
    where: { businessId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return db.scoringModel.create({
    data: {
      businessId,
      version: (latest?.version ?? 0) + 1,
      weights: DEFAULT_WEIGHTS as object,
      isActive: true,
    },
  });
}

export function scoreOne(
  cf: CompanyFeatures,
  weights: Record<string, number>,
  model: { id: string; version: number },
): ScoreResult {
  const byKey = new Map<string, Feature>(cf.features.map((f) => [f.key, f]));

  const factors: ScoredFactor[] = [];
  let total = 0;
  let weightUsed = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const f = byKey.get(key);
    if (!f) continue;
    const contribution = f.value * weight;
    total += contribution;
    weightUsed += weight;
    factors.push({
      factor: key,
      rawValue: Number(f.value.toFixed(3)),
      weight,
      contribution: Number(contribution.toFixed(4)),
      evidence: f.evidence,
    });
  }

  // Normalise by the weight actually applied, so a missing feature lowers
  // confidence rather than silently capping the score.
  const score = Math.round((weightUsed ? total / weightUsed : 0) * 100);
  const tier = score >= 80 ? "HOT" : score >= 50 ? "WARM" : "COLD";
  const grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 45 ? "C" : "D";

  const top = [...factors].sort((a, b) => b.contribution - a.contribution).slice(0, 3);
  const weakest = [...factors].sort((a, b) => a.rawValue - b.rawValue)[0];

  const explanation =
    `${score}/100 (${tier}). ` +
    `Strongest: ${top.map((t) => `${t.factor} — ${t.evidence}`).join("; ")}.` +
    (weakest && weakest.rawValue < 0.34 ? ` Weakest: ${weakest.factor} — ${weakest.evidence}.` : "");

  return { score, tier, grade, factors, explanation, modelId: model.id, modelVersion: model.version };
}
