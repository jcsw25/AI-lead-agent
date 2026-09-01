import { z } from "zod/v4";
import type { PlayLane } from "@prisma/client";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";

/**
 * INDUSTRY SCOUT
 *
 * Sits above the ICP agent. The ICP agent asks "who inside a market do we sell
 * to"; the Scout asks "which whole markets should we be in at all", and is
 * required to justify each with a reason (thesis) and a clock (trigger).
 *
 * The six lanes exist because an unstructured "suggest target industries" prompt
 * returns the same obvious adjacencies every time. Forcing coverage of all six -
 * and requiring the search to run over the whole economy, not the neighbours of
 * what we already sell - is what surfaces things like "florists in the six weeks
 * before Valentine's Day" or "accounting firms during statutory filing season".
 */

const Evidence = z.object({
  claim: z.string(),
  sourceUrl: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

const Play = z.object({
  lane: z.enum(["DIRECT", "ADJACENT", "SEASONAL", "TRIGGER", "CHANNEL", "CONTRARIAN"]),
  industry: z.string(),
  subIndustry: z.string().optional(),
  motion: z.enum(["B2B", "B2C", "B2B2C", "PARTNERSHIP"]),
  /** Why this market would buy from us at all. */
  thesis: z.string(),
  /** Why now - the event, season or condition that creates urgency. */
  buyingTrigger: z.string(),
  /** When to reach out, expressed relative to the trigger. */
  timingWindow: z.string().optional(),
  /** Roles that actually hold the budget - not the company, the person. */
  reachVia: z.array(z.string()).min(1),
  demandStrength: z.number().min(0).max(1),
  reachability: z.number().min(0).max(1),
  competitionLevel: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  dealSizeLow: z.number().optional(),
  dealSizeHigh: z.number().optional(),
  evidence: z.array(Evidence),
});

export type IndustryPlayOut = z.infer<typeof Play>;

const Input = z.object({
  businessName: z.string(),
  whatWeSell: z.string(),
  offerings: z.array(z.object({ name: z.string(), priceLow: z.number().nullable(), priceHigh: z.number().nullable() })),
  regionName: z.string(),
  currency: z.string(),
  todayIso: z.string(),
  upcomingSeasons: z.array(z.object({ name: z.string(), startsOn: z.string(), buyingLeadDays: z.number() })),
  excludeIndustries: z.array(z.string()),
});

const Output = z.object({
  plays: z.array(Play).min(6),
  /** What the scout could not assess and why - surfaced to the user, not hidden. */
  blindSpots: z.array(z.string()),
});

const SYSTEM = `You are an industry scout for a B2B revenue system. Your job is to find whole
markets a business should sell into - not individual companies, and not only the obvious ones.

You must return plays across all six lanes:

DIRECT      Industries that obviously buy what this business sells.
ADJACENT    One step removed: they buy for a different reason than the direct buyers.
SEASONAL    Industries whose OWN peak season creates demand for this business. The
            customer is busy/flush/under pressure at a predictable time of year, and
            that is when they buy. (A florist before Valentine's Day is buying for
            their own peak, not for a gift.)
TRIGGER     Industries currently undergoing change - regulation, funding, expansion,
            technology shifts, labour shortages - where the change creates the need.
CHANNEL     Industries that would resell, bundle, refer or white-label this business
            rather than consume it themselves.
CONTRARIAN  Industries nobody in this business's category targets, where you can
            argue a real commercial case. This lane must genuinely surprise.

Rules:
- Search the whole economy. Do not restrict yourself to industries adjacent to what the
  business already sells. Manufacturing, logistics, healthcare, education, government,
  agriculture, professional services, trades, non-profits and events are all in scope.
- Every play needs a thesis (why them) AND a buying trigger (why now). A play with no
  clock is not a play - drop it.
- reachVia must name the role that holds the budget, not the company.
- Be honest in the scores. competitionLevel is how crowded the market already is;
  a high-demand, high-competition market is still worth listing, just scored accordingly.
- Set confidence low where you are reasoning from general knowledge rather than evidence
  about this specific market, and say so in blindSpots.
- Do not invent statistics, company names, or facts you cannot support.`;

/** Deterministic ranking - the model supplies judgments, arithmetic supplies order. */
export function scorePlay(p: {
  demandStrength: number;
  reachability: number;
  competitionLevel: number;
  confidence: number;
}): number {
  return Number(
    (p.demandStrength * 0.4 + p.reachability * 0.25 + (1 - p.competitionLevel) * 0.2 + p.confidence * 0.15).toFixed(3),
  );
}

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "INDUSTRY_SCOUT",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) => `Business: ${i.businessName}
Sells: ${i.whatWeSell}
Offerings: ${i.offerings.map((o) => `${o.name} (${i.currency} ${o.priceLow ?? "?"}-${o.priceHigh ?? "?"})`).join("; ")}
Market: ${i.regionName}
Today: ${i.todayIso}
Seasonal windows ahead: ${i.upcomingSeasons.map((s) => `${s.name} starts ${s.startsOn}, buy ~${s.buyingLeadDays}d before`).join("; ") || "none recorded"}
${i.excludeIndustries.length ? `Already covered, do not repeat: ${i.excludeIndustries.join(", ")}` : ""}

Return at least 12 plays with every lane represented at least once.`,
  mock: (i) => mockPlays(i),
};

export async function runIndustryScout(businessId: string) {
  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { profile: true, offerings: true, region: true },
  });

  const today = new Date();
  const horizon = new Date(today.getTime() + 220 * 864e5);
  const seasons = await db.seasonalWindow.findMany({
    where: { regionId: business.regionId, startsOn: { gte: today, lte: horizon } },
    orderBy: { startsOn: "asc" },
    take: 8,
  });

  const existing = await db.industryPlay.findMany({
    where: { businessId, status: { in: ["accepted", "proposed"] } },
    select: { industry: true },
  });

  const { output, runId, simulated } = await runAgent(
    agent,
    {
      businessName: business.name,
      whatWeSell:
        (business.profile?.whatWeSell as { summary?: string } | null)?.summary ??
        business.offerings.map((o) => o.name).join(", ") ??
        "unspecified",
      offerings: business.offerings.map((o) => ({
        name: o.name,
        priceLow: o.priceMin ? Number(o.priceMin) : null,
        priceHigh: o.priceMax ? Number(o.priceMax) : null,
      })),
      regionName: business.region.name,
      currency: business.region.currency,
      todayIso: today.toISOString().slice(0, 10),
      upcomingSeasons: seasons.map((s) => ({
        name: s.name,
        startsOn: s.startsOn.toISOString().slice(0, 10),
        buyingLeadDays: s.buyingLeadDays,
      })),
      excludeIndustries: existing.map((e) => e.industry),
    },
    { businessId },
  );

  const seasonByName = new Map(seasons.map((s) => [s.name.toLowerCase(), s.id]));

  await db.industryPlay.createMany({
    data: output.plays.map((p) => ({
      businessId,
      lane: p.lane as PlayLane,
      industry: p.industry,
      subIndustry: p.subIndustry ?? null,
      motion: p.motion,
      thesis: p.thesis,
      buyingTrigger: p.buyingTrigger,
      timingWindow: p.timingWindow ?? null,
      reachVia: p.reachVia,
      seasonalWindowId:
        [...seasonByName.entries()].find(([n]) => p.buyingTrigger.toLowerCase().includes(n))?.[1] ?? null,
      demandStrength: p.demandStrength,
      reachability: p.reachability,
      competitionLevel: p.competitionLevel,
      confidence: p.confidence,
      score: scorePlay(p),
      dealSizeLow: p.dealSizeLow ?? null,
      dealSizeHigh: p.dealSizeHigh ?? null,
      currency: business.region.currency,
      evidence: p.evidence,
      agentRunId: runId,
    })),
  });

  return { count: output.plays.length, blindSpots: output.blindSpots, simulated };
}

// ---------------------------------------------------------------------------
// Simulated output, used only when ANTHROPIC_API_KEY is unset.
// Demonstrates the SHAPE of the six lanes so the UI is explorable offline.
// The UI labels anything produced here as simulated.
// ---------------------------------------------------------------------------

function mockPlays(i: z.infer<typeof Input>): z.infer<typeof Output> {
  const ev = (claim: string, confidence = 0.5) => [{ claim, confidence }];
  const p = (
    lane: IndustryPlayOut["lane"],
    industry: string,
    motion: IndustryPlayOut["motion"],
    thesis: string,
    buyingTrigger: string,
    timingWindow: string,
    reachVia: string[],
    nums: [number, number, number, number],
    deal?: [number, number],
  ): IndustryPlayOut => ({
    lane,
    industry,
    motion,
    thesis,
    buyingTrigger,
    timingWindow,
    reachVia,
    demandStrength: nums[0],
    reachability: nums[1],
    competitionLevel: nums[2],
    confidence: nums[3],
    dealSizeLow: deal?.[0],
    dealSizeHigh: deal?.[1],
    evidence: ev("Simulated output — no research was performed.", nums[3]),
  });

  return {
    plays: [
      p("DIRECT", "Banking & wealth management", "B2B",
        "Client-facing teams with large relationship-management budgets and a standing need for premium client gifts.",
        "Year-end client appreciation cycle and Q4 relationship reviews.",
        "8–10 weeks before December",
        ["Head of People & Culture", "Client Relationship Director", "Marketing Manager"],
        [0.9, 0.6, 0.75, 0.5], [8000, 40000]),

      p("DIRECT", "Corporate law & professional services", "B2B",
        "Partner-led firms that gift at matter completion and during referral cultivation.",
        "Financial year end and post-deal closings.",
        "4–6 weeks before FY end",
        ["Practice Manager", "Business Development Manager"],
        [0.75, 0.7, 0.55, 0.5], [3000, 15000]),

      p("ADJACENT", "Commercial real estate & property development", "B2B",
        "Launches and handovers need a premium touch item for buyers and brokers, budgeted per project rather than per year.",
        "New launch or TOP handover events.",
        "6 weeks before a launch event",
        ["Marketing Director", "Sales Gallery Manager"],
        [0.7, 0.6, 0.4, 0.45], [5000, 25000]),

      p("SEASONAL", "Florists and gift retailers", "B2B2C",
        "Their own peak forces them to widen basket size fast. A complementary premium add-on lifts their average order without new supplier risk.",
        "Valentine's Day and Mother's Day demand spikes — they buy stock ahead of their own peak, not for themselves.",
        "6–8 weeks before 14 February",
        ["Owner", "Head Buyer"],
        [0.8, 0.85, 0.3, 0.45], [1500, 8000]),

      p("SEASONAL", "Hotels & serviced residences", "B2B",
        "Turndown amenities, VIP arrivals and festive packages are planned on a fixed seasonal calendar.",
        "Festive package planning and peak-season occupancy.",
        "10–12 weeks before the season",
        ["F&B Director", "Guest Experience Manager", "Procurement"],
        [0.75, 0.55, 0.5, 0.45], [4000, 30000]),

      p("TRIGGER", "Technology companies post-funding", "B2B",
        "A funding round converts into headcount, and new headcount creates onboarding and culture spend that did not exist the quarter before.",
        "Series A–C raise, or a hiring spree above 30 roles.",
        "Within 90 days of the raise being announced",
        ["Head of People", "Office Manager", "Chief of Staff"],
        [0.7, 0.75, 0.35, 0.4], [2000, 12000]),

      p("TRIGGER", "Healthcare groups and clinic networks", "B2B",
        "Clinic network expansion drives referrer-relationship spend, which is rarely served by premium suppliers.",
        "New clinic openings and specialist referral drives.",
        "At opening announcement",
        ["Practice Director", "Marketing Lead"],
        [0.55, 0.5, 0.2, 0.35], [1500, 9000]),

      p("CHANNEL", "Corporate event and experiential agencies", "PARTNERSHIP",
        "Agencies specify gifting on behalf of many clients. One agency relationship reaches dozens of end buyers without per-account acquisition cost.",
        "Event calendar build-out for the coming year.",
        "Q3, when next-year budgets are scoped",
        ["Account Director", "Production Lead"],
        [0.8, 0.7, 0.4, 0.45], [10000, 60000]),

      p("CHANNEL", "Concierge, private aviation and members' clubs", "PARTNERSHIP",
        "They need a reliable premium supplier for member requests and would rather white-label than build capability.",
        "Membership renewal cycles and service-tier refreshes.",
        "Ahead of annual renewal periods",
        ["Membership Director", "Concierge Manager"],
        [0.6, 0.45, 0.2, 0.35], [3000, 20000]),

      p("CONTRARIAN", "Logistics, freight forwarding and marine services", "B2B",
        "Unglamorous, relationship-driven, and almost never targeted by premium suppliers. Contract renewals are won on relationship maintenance, and gifting budgets exist but are unserved.",
        "Annual contract renewal and shipping peak season.",
        "8 weeks before contract renewal dates",
        ["Commercial Director", "Key Account Manager"],
        [0.55, 0.55, 0.1, 0.3], [2000, 14000]),

      p("CONTRARIAN", "Insurance brokerages and financial advisory", "B2B",
        "Advisers compete almost entirely on retention. A recurring, personal touchpoint is worth more to them than to most industries, and category competition is low.",
        "Policy renewal anniversaries, which are known months in advance.",
        "4 weeks before renewal dates",
        ["Agency Leader", "Practice Principal"],
        [0.65, 0.7, 0.15, 0.35], [1000, 10000]),

      p("ADJACENT", "Universities, business schools and alumni offices", "B2B",
        "Donor cultivation and executive-education cohorts carry real hospitality budgets and behave like corporates.",
        "Graduation, donor events and cohort intakes.",
        "6 weeks before term dates",
        ["Alumni Relations Manager", "Executive Education Director"],
        [0.5, 0.6, 0.15, 0.3], [1500, 9000]),
    ],
    blindSpots: [
      "This is simulated output — no web research was performed. Add ANTHROPIC_API_KEY to run the scout for real.",
      `Deal sizes are illustrative and not based on ${i.regionName} market data.`,
      "Competition levels are assumed, not measured — no competitor scan has run.",
    ],
  };
}

export const industryScout = agent;
