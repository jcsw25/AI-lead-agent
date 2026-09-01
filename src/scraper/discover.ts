import { db } from "@/lib/db";
import { getSearchAdapters, type DiscoveredTarget } from "@/adapters/search";
import { ingestDomain } from "./ingest";
import { registrableDomain } from "@/lib/domain";

/**
 * Finds its own targets for a pairing, then scrapes the ones that have a site.
 *
 * Two outcomes are both valid and both recorded:
 *
 *   with a website  -> crawled, contacts extracted, full SupplierLead
 *   without one     -> still recorded from the directory data (name, address,
 *                      often a phone). Measured on Singapore laundries only
 *                      ~5% of OpenStreetMap entries carry a website, so
 *                      discarding the rest would throw away most of the market.
 *
 * A lead you can phone is still a lead. The `source` field records which it is
 * so the outreach side never assumes an email exists.
 */

export type DiscoverResult = {
  runId: string;
  searched: number;
  withWebsite: number;
  scraped: number;
  directoryOnly: number;
  skippedKnown: number;
  adapters: string[];
};

export async function discoverForPairing(
  businessId: string,
  pairingId: string,
  opts: { limit?: number; side?: "A" | "B" } = {},
): Promise<DiscoverResult> {
  const limit = opts.limit ?? 25;
  const side = opts.side ?? "A";

  const pairing = await db.pairing.findUniqueOrThrow({ where: { id: pairingId } });
  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { region: true },
  });

  // Side A recruits suppliers; side B finds buyers. Same machinery, different query.
  const industry = side === "A" ? pairing.supplierIndustry : pairing.buyerIndustry;

  const run = await db.scrapeRun.create({
    data: { businessId, pairingId, mode: "search", query: `${industry} in ${business.region.name} (side ${side})` },
  });

  const adapters = getSearchAdapters();
  const found = new Map<string, DiscoveredTarget>();

  const alreadyHeld = new Set(
    (await db.company.findMany({ select: { primaryDomain: true } }))
      .map((c) => c.primaryDomain)
      .filter((d): d is string => Boolean(d)),
  );

  for (const adapter of adapters) {
    if (found.size >= limit) break;
    try {
      const targets = await adapter.discover(industry, business.region.name, limit, { exclude: alreadyHeld });
      for (const t of targets) {
        // Dedupe on domain where we have one, otherwise on normalised name.
        const key = registrableDomain(t.website ?? "") ?? t.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!found.has(key)) found.set(key, t);
      }
    } catch (e) {
      console.error(`[discover] ${adapter.name} failed:`, e instanceof Error ? e.message : e);
    }
  }

  const targets = [...found.values()].slice(0, limit);
  const known = new Set(
    (await db.company.findMany({ select: { primaryDomain: true } }))
      .map((c) => c.primaryDomain)
      .filter((d): d is string => Boolean(d)),
  );

  let scraped = 0;
  let directoryOnly = 0;
  let skippedKnown = 0;
  const log: unknown[] = [];

  for (const t of targets) {
    const domain = registrableDomain(t.website ?? "");

    if (domain && known.has(domain)) {
      skippedKnown++;
      continue;
    }

    if (domain) {
      const r = await ingestDomain(businessId, t.website!, {
        pairingId,
        asSupplierLead: side === "A",
        runId: run.id,
        knownName: t.name,
      });
      if (!r.skipped) scraped++;
      log.push({ ...r, discoveredVia: t.source });
      continue;
    }

    // No website. Record what the directory gave us rather than discarding it.
    const company = await db.company.create({
      data: {
        name: t.name,
        regionId: business.regionId,
        addressLine: t.address,
        city: business.region.name,
        countryCode: business.region.code,
        industry,
        // Directory data is sourced but unconfirmed by the company itself.
        verification: "INFERRED",
        lastResearchedAt: new Date(),
      },
    });

    if (t.phone) {
      await db.claim.create({
        data: {
          companyId: company.id,
          field: "company.phone",
          value: t.phone,
          confidence: 0.7,
          verification: "INFERRED",
          sourceUrl: t.sourceRef,
          observedAt: new Date(),
          agentRunId: run.id,
        },
      });
      await db.contact.create({
        data: {
          companyId: company.id,
          fullName: `${t.name} (main line)`,
          jobTitle: "General enquiries",
          phone: t.phone,
          email: null,
          sourceUrl: t.sourceRef,
          sourceType: "public_registry",
          isBusinessContactInfo: true,
          verification: "INFERRED",
        },
      });
    }

    if (side === "A") {
      await db.supplierLead.create({
        data: {
          businessId,
          companyId: company.id,
          pairingId,
          source: "SEARCH",
          // Phone-only is reachable, just not by email.
          status: t.phone ? "IDENTIFIED" : "UNREACHABLE",
          contactScore: t.phone ? 20 : 5,
          contactTier: t.phone ? "PARTIAL" : "THIN",
          bestPhone: t.phone,
          hasNamedContact: false,
          whatTheySell: industry,
          scrapedAt: new Date(),
          scrapeNotes: {
            quality: [t.phone ? "phone from directory, no website found" : "directory listing only, no contact route"],
            discoveredVia: t.source,
            sourceRef: t.sourceRef,
          } as object,
        },
      });
    }
    directoryOnly++;
    log.push({ name: t.name, phone: t.phone ?? null, directoryOnly: true, discoveredVia: t.source });
  }

  const withWebsite = targets.filter((t) => t.website).length;

  await db.scrapeRun.update({
    where: { id: run.id },
    data: {
      status: "done",
      targetsAttempted: targets.length,
      companiesCreated: scraped + directoryOnly,
      log: log as object,
      finishedAt: new Date(),
    },
  });

  return {
    runId: run.id,
    searched: targets.length,
    withWebsite,
    scraped,
    directoryOnly,
    skippedKnown,
    adapters: adapters.map((a) => a.name),
  };
}
