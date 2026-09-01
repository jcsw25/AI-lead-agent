import { db } from "@/lib/db";

/**
 * Single-tenant shortcut for local development. Real auth (and the businessId
 * from the session) lands in Phase 0.5 — see docs/05-roadmap.md.
 */
export async function currentBusiness() {
  return db.business.findFirst({
    orderBy: { createdAt: "asc" },
    include: { region: true, profile: true, offerings: true },
  });
}

export const LANE_COPY: Record<string, { title: string; blurb: string }> = {
  DIRECT: {
    title: "Direct",
    blurb: "Industries that obviously buy what you sell. Highest confidence, most competition.",
  },
  ADJACENT: {
    title: "Adjacent",
    blurb: "One step removed — they buy for a different reason than the obvious buyers do.",
  },
  SEASONAL: {
    title: "Seasonal",
    blurb:
      "Their own peak creates your opportunity. A florist buys ahead of Valentine's Day because that is when their demand spikes — not because they want a gift.",
  },
  TRIGGER: {
    title: "Trigger-driven",
    blurb: "Industries changing right now — funding, expansion, regulation, hiring — where the change creates the need.",
  },
  CHANNEL: {
    title: "Channel & partnership",
    blurb: "They resell, bundle or refer you. One relationship reaches many end buyers.",
  },
  CONTRARIAN: {
    title: "Contrarian",
    blurb: "Industries nobody in your category targets. Lower confidence by design — this lane exists to surprise you.",
  },
};

export const LANE_ORDER = ["DIRECT", "SEASONAL", "TRIGGER", "CHANNEL", "ADJACENT", "CONTRARIAN"] as const;
