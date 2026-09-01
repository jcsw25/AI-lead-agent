import { db } from "@/lib/db";
import { getSearchAdapters } from "@/adapters/search";
import { ingestDomain } from "@/scraper/ingest";
import { registrableDomain } from "@/lib/domain";
import { planQueries, recordPlanYield } from "@/agents/query-strategist";

/**
 * Discover companies in an industry and persist them.
 *
 * This is the one implementation. The generator's server action and the
 * backfill script both call it, because the previous arrangement — a server
 * action that wrote to the database and a throwaway script that only printed
 * to the console — produced a number ("86 companies found") that was never
 * true of anything stored. Any path that reports a count must be the path that
 * writes the rows.
 */

export type DiscoverIndustryResult = {
  runId: string;
  /** The phrasings actually sent to the search engines, and where they came from. */
  queries: string[];
  querySource: "agent" | "heuristic" | "cache";
  found: number;
  created: number;
  crawled: number;
  skippedKnown: number;
  /**
   * What each search provider did. `skipped` is a deliberate choice, not a
   * problem — it must stay distinct from `error`, because reporting an
   * optimisation as a failure makes a healthy run look broken.
   */
  adapterLog: Array<{ adapter: string; found: number; error?: string; skipped?: string }>;
};

export async function discoverIndustry(
  businessId: string,
  industry: string,
  opts: { limit?: number; crawl?: boolean } = {},
): Promise<DiscoverIndustryResult> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 300);
  const crawl = opts.crawl ?? false;

  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { region: true },
  });

  const run = await db.scrapeRun.create({
    data: { businessId, mode: "search", query: `industry: ${industry}` },
  });

  // Hand the adapters everything we already hold. Filtering after the fact
  // still pays for the tokens and the query quota; excluding up front does not.
  const known = new Set(
    (await db.company.findMany({ select: { primaryDomain: true } }))
      .map((c) => c.primaryDomain)
      .filter((d): d is string => Boolean(d)),
  );

  // One plan per industry, shared by every adapter. Generating it inside each
  // adapter would pay for the same model call two or three times per search.
  const plan = await planQueries(industry, business.region.name, { businessId });
  const planned = plan.queries.map((q) => q.query);

  const found = new Map<string, { name: string; website?: string; phone?: string; address?: string; sourceRef: string }>();
  const adapters = getSearchAdapters();
  // A failing adapter used to be swallowed, so a broken web search looked
  // identical to "there were no results". Record what each one did.
  const adapterLog: DiscoverIndustryResult["adapterLog"] = [];

  const failRun = async (e: unknown) => {
    await db.scrapeRun.update({
      where: { id: run.id },
      data: { status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 500), finishedAt: new Date() },
    });
  };

  for (const a of adapters) {
    if (found.size >= limit) break;
    // Anthropic web search is minutes per call where Serper is seconds. Run it
    // only when the fast adapters came back thin, otherwise a healthy search
    // pays ten minutes for results it already has.
    if (a.name === "anthropic" && found.size >= Math.min(25, limit * 0.5)) {
      adapterLog.push({ adapter: a.name, found: 0, skipped: "not needed — Google already returned enough" });
      continue;
    }
    try {
      const hits = await a.discover(industry, business.region.name, limit, {
        exclude: known,
        queries: planned,
        negatives: plan.negatives,
      });
      adapterLog.push({ adapter: a.name, found: hits.length });
      for (const t of hits) {
        // Chains have several outlets. Keying on name alone collapses them into
        // one and silently loses real locations, so include the address.
        const key =
          registrableDomain(t.website ?? "") ??
          `${t.name}|${t.address ?? ""}`.toLowerCase().replace(/[^a-z0-9|]/g, "");
        if (!found.has(key)) found.set(key, t);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      adapterLog.push({ adapter: a.name, found: 0, error: msg.slice(0, 300) });
      console.error(`[discover] ${a.name}:`, msg);
    }
  }

  let created = 0;
  let crawled = 0;
  let skippedKnown = 0;

  try {
    for (const t of [...found.values()].slice(0, limit)) {
      const domain = registrableDomain(t.website ?? "");

      if (domain && crawl) {
        const r = await ingestDomain(businessId, t.website!, { runId: run.id, knownName: t.name });
        if (!r.skipped) crawled++;
        else skippedKnown++;
        continue;
      }

      const existing = domain
        ? await db.company.findUnique({ where: { primaryDomain: domain } })
        : await db.company.findFirst({ where: { name: t.name, regionId: business.regionId } });
      if (existing) {
        skippedKnown++;
        continue;
      }

      const c = await db.company.create({
        data: {
          name: t.name,
          primaryDomain: domain,
          websiteUrl: t.website,
          addressLine: t.address,
          industry,
          regionId: business.regionId,
          countryCode: business.region.code,
          city: business.region.name,
          verification: "INFERRED",
          lastResearchedAt: new Date(),
        },
      });
      created++;

      if (t.phone) {
        await db.contact.create({
          data: {
            companyId: c.id,
            fullName: `${t.name} (main line)`,
            jobTitle: "General enquiries",
            phone: t.phone,
            sourceUrl: t.sourceRef,
            sourceType: "public_registry",
            isBusinessContactInfo: true,
            verification: "INFERRED",
          },
        });
        await db.claim.create({
          data: {
            companyId: c.id, field: "company.phone", value: t.phone, confidence: 0.7,
            verification: "INFERRED", sourceUrl: t.sourceRef, observedAt: new Date(), agentRunId: run.id,
          },
        });
      }
    }
  } catch (e) {
    await failRun(e);
    throw e;
  }

  await db.scrapeRun.update({
    where: { id: run.id },
    data: {
      status: "done",
      targetsAttempted: found.size,
      companiesCreated: created + crawled,
      finishedAt: new Date(),
      log: {
        industry, limit, found: found.size, created, crawled, skippedKnown,
        adapters: adapterLog,
        queries: planned,
        querySource: plan.source,
        queryRationale: plan.rationale,
      } as object,
      // Only genuine failures land in `error`. A skip is not one.
      error: adapterLog.filter((a) => a.error).map((a) => `${a.adapter}: ${a.error}`).join(" | ") || null,
    },
  });

  await recordPlanYield(plan.planId, created + crawled);

  return {
    runId: run.id,
    queries: planned,
    querySource: plan.source,
    found: found.size,
    created, crawled, skippedKnown, adapterLog,
  };
}
