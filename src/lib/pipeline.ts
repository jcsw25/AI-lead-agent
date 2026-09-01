import type { LeadTier, ProspectStage } from "@prisma/client";

/**
 * The board the operator actually works from. Prospect.stage and .tier are the
 * stored truth; this collapses them into the six questions people ask:
 * have we contacted them, did they reply, do they want to buy, did we connect
 * the two sides, did it close.
 */
export const COLUMNS = [
  { key: "TO_CONTACT", label: "To contact", hint: "Found and matched, not yet approached" },
  { key: "CONTACTED", label: "Contacted", hint: "Outreach sent, awaiting a reply" },
  { key: "WARM", label: "Warm", hint: "Replied with interest, not committed" },
  { key: "HOT", label: "Hot", hint: "Wants to buy — act today" },
  { key: "INTRODUCED", label: "Introduced", hint: "Both sides connected, commission in play" },
  { key: "CLOSED", label: "Closed", hint: "Won, lost or suppressed" },
] as const;

export type ColumnKey = (typeof COLUMNS)[number]["key"];

export function columnFor(p: { stage: ProspectStage; tier: LeadTier | null }): ColumnKey {
  switch (p.stage) {
    case "WON":
    case "LOST":
    case "DISQUALIFIED":
    case "SUPPRESSED":
      return "CLOSED";
    case "MEETING":
      return "INTRODUCED";
    case "OPPORTUNITY":
      return p.tier === "HOT" ? "HOT" : "INTRODUCED";
    case "ENGAGED":
      return p.tier === "HOT" ? "HOT" : "WARM";
    case "CONTACTED":
    case "QUEUED":
      return "CONTACTED";
    default:
      return "TO_CONTACT";
  }
}

export const TIER_CLASS: Record<string, string> = { HOT: "crit", WARM: "ochre", COLD: "ink-faint" };

export function money(v: unknown, ccy = "SGD"): string | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return `${ccy} ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
