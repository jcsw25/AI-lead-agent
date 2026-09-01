import { z } from "zod/v4";
import { type AgentDef, runAgent, hasApiKey } from "./runtime";
import { db } from "@/lib/db";

/**
 * QUERY STRATEGIST
 *
 * Turns one industry into the set of searches that actually surfaces the
 * companies in it.
 *
 * The problem this solves is measurable: Google ranks the same ~20 domains for
 * any single phrasing however deep you page, so depth comes from asking the
 * same question in genuinely different vocabularies — consumer, trade,
 * procurement, and service-specific. Previously that expansion was hardcoded
 * for five trades and everything else got "<industry> company" and
 * "<industry> services provider", which Google treats as the same query. That
 * is why "dental clinic" returned 8 companies and "aircon servicing" returned
 * dozens: not a difference in the market, a difference in whether the variants
 * happened to have been hand-written.
 *
 * One call per industry, cached in QueryPlan, so the cost is paid once.
 */

const Input = z.object({
  industry: z.string(),
  region: z.string(),
  /** Phrasings already tried, so a refresh explores instead of repeating. */
  avoid: z.array(z.string()).default([]),
});

const QueryItem = z.object({
  query: z.string(),
  /**
   * Which vocabulary this query reaches for. Two queries with the same intent
   * are usually the same search; the spread across intents is what produces
   * new domains.
   */
  intent: z.enum(["core", "synonym", "trade", "service", "adjacent", "buyer_language"]),
  why: z.string(),
});

const Output = z.object({
  queries: z.array(QueryItem).min(5).max(12),
  /** Words that mark a result as a directory, blog or comparison page. */
  negatives: z.array(z.string()),
  /** How this industry is actually named by the people working in it. */
  rationale: z.string(),
});

const SYSTEM = `You write Google search queries that find OPERATING COMPANIES in a trade.

You are not writing queries for a human reader. Each one is sent to Google verbatim with
the region appended, and every distinct domain in the results becomes a sales lead. Your
only measure of success is how many DIFFERENT real companies the set surfaces.

Produce 6-10 queries spread across these intents:

- core            the industry as given, cleaned up into how it is actually searched
- synonym         the same trade under a different name. Regional vocabulary matters:
                  Singapore says "aircon", the US says "HVAC", the UK says "air con". A
                  US-only synonym wastes a query in Singapore.
- trade           how the industry describes ITSELF on its own website and in tenders —
                  "M&E contractor", "facilities management", "corporate secretarial".
                  These surface established firms that never target consumers.
- service         one specific, high-volume service the trade sells. Companies rank for
                  the job, not the category: "chemical overhaul", "grease trap cleaning",
                  "scaling and polishing".
- adjacent        a neighbouring capability the same firms usually also sell. Catches
                  companies whose site leads with a different service.
- buyer_language  how a business BUYING this would phrase it: "commercial", "corporate",
                  "office", "for hotels", "B2B", "contract". Surfaces suppliers who serve
                  businesses rather than households — usually the ones worth contacting.

0. IF THE INPUT IS A PRODUCT, SEARCH FOR THE BUSINESSES THAT MAKE OR SELL IT.
   This is the single biggest failure mode. A trade name like "aircon servicing"
   returns companies. A product noun like "mooncake", "chocolate" or "uniforms"
   returns news articles, recipe blogs, listicles and marketplace listings,
   because that is what ranks for a product word. Measured: a "mooncake" search
   returned 54 results of which 20 were news sites and platforms.
   So convert it. "mooncake" is not a query — "mooncake manufacturer",
   "traditional confectionery bakery", "corporate mooncake gift supplier" are.
   Add words that only a BUSINESS would put on its own site: manufacturer,
   supplier, wholesale, distributor, factory, bakery, contractor, services, B2B,
   corporate, bulk order, trade enquiries. Say in rationale that you did this.

Rules that decide whether this is worth its credits:

1. NEVER return two queries that differ only by a filler word. "dental clinic", "dental
   clinic company" and "dental clinic services provider" are ONE query as far as Google is
   concerned, and returning them wastes two thirds of the budget. If you cannot find a
   genuinely different vocabulary for an intent, return fewer queries.
2. Do NOT put the region in the query. It is appended automatically.
3. No search operators, quotes, minus signs, or site: filters. Plain phrases only.
4. Prefer terms a real company puts on its own homepage over terms a marketer would
   invent. You are matching against their copy, not writing an ad.
5. Avoid words that pull up listicles and directories — "best", "top", "cheap", "review",
   "vs", "near me", "list of", "price". Those return aggregators, not companies.
6. negatives: words whose presence in a result TITLE means it is a directory, blog,
   listicle or marketplace rather than a company. Include any specific to this trade.
7. rationale: one or two sentences on how this trade is actually named by the people in
   it, and anything about the region that changed your choices.

If the industry as given is vague ("services", "tech"), say so in rationale and write
queries for the most commercially plausible reading rather than refusing.`;

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "QUERY_STRATEGIST",
  // Haiku is enough: this is vocabulary generation, not judgement, and it runs
  // once per industry. At ~800 tokens in and ~600 out it is well under a cent.
  model: "claude-haiku-4-5",
  effort: "medium",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) =>
    `Industry: ${i.industry}\nRegion: ${i.region}` +
    (i.avoid.length
      ? `\n\nAlready tried — find different vocabulary, do not repeat these:\n${i.avoid.map((a) => `- ${a}`).join("\n")}`
      : ""),
  mock: (i) => ({
    queries: heuristicVariants(i.industry).map((query, n) => ({
      query,
      intent: (n === 0 ? "core" : "synonym") as "core" | "synonym",
      why: "Heuristic fallback — no API key set, so no vocabulary was generated.",
    })),
    negatives: [...GENERIC_NEGATIVES],
    rationale:
      "No ANTHROPIC_API_KEY, so these are the hardcoded variants. Coverage will be shallow " +
      "for any trade outside the five with hand-written rules.",
  }),
};

/** Directory and listicle markers that apply to every trade. */
export const GENERIC_NEGATIVES = [
  "best", "top", "cheap", "review", "reviews", "vs", "compare", "list of",
  "directory", "near me", "price", "cost", "ranking", "guide", "blog",
];

/**
 * The fallback, kept deliberately.
 *
 * When the model is unavailable a single query is a much worse outcome than a
 * blunt expansion, so the old hardcoded rules stay as a floor rather than being
 * deleted once the agent works.
 */
export function heuristicVariants(industry: string): string[] {
  const base = industry.trim();
  const out = [base];
  const add = (v: string) => {
    if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };

  if (/aircon|air-?con|hvac|air condition/i.test(base)) {
    add("air conditioning servicing company");
    add("aircon maintenance contractor");
    add("aircon chemical wash repair");
  } else if (/laundry|linen/i.test(base)) {
    add("commercial laundry service");
    add("linen rental hotel");
  } else if (/pest/i.test(base)) {
    add("pest control company");
    add("termite treatment services");
  } else if (/clean/i.test(base)) {
    add("commercial cleaning contractor");
    add("office cleaning services");
  } else {
    add(`${base} company`);
    add(`${base} services provider`);
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const planKey = (industry: string, region: string) => `${norm(industry)}|${norm(region)}`;

export type PlannedQuery = z.infer<typeof QueryItem>;
export type QueryPlanResult = {
  queries: PlannedQuery[];
  negatives: string[];
  rationale: string;
  source: "agent" | "heuristic" | "cache";
  planId: string | null;
};

/**
 * The plan for one industry, from cache when possible.
 *
 * Never throws. A failure here must degrade to the heuristic variants rather
 * than taking down a search — a shallow search is recoverable, a crashed one
 * loses the credits already spent.
 */
export async function planQueries(
  industry: string,
  region: string,
  opts: { refresh?: boolean; businessId?: string } = {},
): Promise<QueryPlanResult> {
  const key = planKey(industry, region);

  if (!opts.refresh) {
    try {
      const cached = await db.queryPlan.findUnique({ where: { key } });
      if (cached) {
        await db.queryPlan.update({ where: { key }, data: { timesUsed: { increment: 1 } } });
        return {
          queries: cached.queries as PlannedQuery[],
          negatives: (cached.negatives as string[] | null) ?? GENERIC_NEGATIVES,
          rationale: cached.rationale ?? "",
          source: "cache",
          planId: cached.id,
        };
      }
    } catch (e) {
      console.error("[query-strategist] cache read failed:", e instanceof Error ? e.message : e);
    }
  }

  const fallback = (): QueryPlanResult => ({
    queries: heuristicVariants(industry).map((query, n) => ({
      query,
      intent: n === 0 ? ("core" as const) : ("synonym" as const),
      why: "Heuristic fallback.",
    })),
    negatives: GENERIC_NEGATIVES,
    rationale: "Heuristic variants — the strategist was unavailable.",
    source: "heuristic",
    planId: null,
  });

  let result: QueryPlanResult;
  let agentRunId: string | null = null;

  try {
    const avoid = opts.refresh
      ? (((await db.queryPlan.findUnique({ where: { key } }))?.queries as PlannedQuery[] | undefined) ?? []).map(
          (q) => q.query,
        )
      : [];
    const run = await runAgent(agent, { industry, region, avoid }, { businessId: opts.businessId });
    agentRunId = run.runId;
    result = {
      queries: run.output.queries,
      negatives: [...new Set([...GENERIC_NEGATIVES, ...run.output.negatives])],
      rationale: run.output.rationale,
      source: hasApiKey() ? "agent" : "heuristic",
      planId: null,
    };
  } catch (e) {
    console.error("[query-strategist] failed, falling back:", e instanceof Error ? e.message : e);
    result = fallback();
  }

  // The prompt forbids putting the region in the query because the adapters
  // append it, but the model does it anyway often enough to matter — "dentist
  // Singapore" becomes "dentist Singapore Singapore", which Google treats as a
  // worse query than either. Strip it rather than trusting the instruction.
  const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regionWords = norm(region)
    .split(" ")
    .filter((w) => w.length > 2);
  const stripRegion = (q: string) => {
    let out = q;
    for (const w of regionWords) {
      out = out.replace(new RegExp(`\\b${escapeRe(w)}\\b`, "gi"), " ");
    }
    return out.replace(/\s+/g, " ").trim();
  };
  result.queries = result.queries
    .map((q) => ({ ...q, query: stripRegion(q.query) }))
    .filter((q) => q.query.length > 2);

  // Dedupe defensively: the prompt forbids near-duplicates, but a wasted credit
  // is not worth trusting a prompt over.
  const seen = new Set<string>();
  result.queries = result.queries.filter((q) => {
    const k = norm(q.query)
      .replace(/\b(company|companies|services?|provider|providers|solutions?)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!result.queries.length) result = fallback();

  try {
    const saved = await db.queryPlan.upsert({
      where: { key },
      create: {
        key,
        industry,
        region,
        queries: result.queries as object,
        negatives: result.negatives as object,
        rationale: result.rationale,
        source: result.source === "cache" ? "agent" : result.source,
        agentRunId,
        timesUsed: 1,
      },
      update: {
        queries: result.queries as object,
        negatives: result.negatives as object,
        rationale: result.rationale,
        source: result.source === "cache" ? "agent" : result.source,
        agentRunId,
        timesUsed: { increment: 1 },
      },
    });
    result.planId = saved.id;
  } catch (e) {
    console.error("[query-strategist] cache write failed:", e instanceof Error ? e.message : e);
  }

  return result;
}

/** Record what a plan actually yielded, so weak phrasings are visible. */
export async function recordPlanYield(planId: string | null, companiesFound: number) {
  if (!planId) return;
  try {
    await db.queryPlan.update({
      where: { id: planId },
      data: { companiesFound: { increment: companiesFound } },
    });
  } catch {
    /* telemetry must never break a search */
  }
}
