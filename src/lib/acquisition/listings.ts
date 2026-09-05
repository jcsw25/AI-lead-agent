import * as cheerio from "cheerio";
import { db } from "@/lib/db";
import { politeFetch } from "@/scraper/fetcher";
import { runAgent } from "@/agents/runtime";
import { askingMultiple, isPropertyNotBusiness, listingExtractor } from "@/agents/listing-extractor";
import { crawlListingIndex } from "@/lib/acquisition/index-crawl";
import { MARKETPLACES, type Marketplace } from "@/lib/acquisition/marketplaces";

/**
 * Collecting the businesses currently advertised for sale in Singapore.
 *
 * This deliberately does not reuse the company discovery adapters, and the
 * reason is structural. Discovery deduplicates by registrable domain and drops
 * aggregators, because there one company means one website. Here every listing
 * on a marketplace shares a domain and the aggregator IS the source — running
 * listings through that path returns one business per marketplace and discards
 * the rest.
 *
 * Nor does it use web search, which was tried first and measured: see the note
 * in index-crawl.ts. Each marketplace's own browse page is read instead.
 *
 * Everything advertised is collected rather than only one industry's worth. A
 * marketplace's inventory is a few hundred businesses in total, the whole set
 * costs about twenty cents to read, and an industry filter applied during
 * collection would have to be re-run — and re-paid — every time the question
 * changed. Filtering happens when you look at them.
 */

export type ListingScrapeResult = {
  sourcesRead: number;
  urlsSeen: number;
  pagesFetched: number;
  created: number;
  skipped: Array<{ url: string; why: string }>;
  bySource: Record<string, number>;
  costUsd: number;
};

/**
 * Is this "reason for selling" actually about this business?
 *
 * All 22 listings collected from one marketplace gave the identical reason —
 * "Owner relocating overseas" — which is not twenty-two owners emigrating, it
 * is the site's placeholder text. Presented as a per-listing fact it is worse
 * than useless: retirement and relocation are the reasons worth answering
 * fastest, so boilerplate that mimics them corrupts the one field that decides
 * what to open first.
 *
 * Detected by repetition rather than by a list of known phrases, because the
 * placeholder differs per site and a hardcoded list would only ever catch the
 * sites already seen.
 */
async function isBoilerplateReason(
  businessId: string,
  source: string,
  reason: string,
): Promise<boolean> {
  const same = await db.acquisitionTarget.count({
    where: { businessId, listingSource: source, sellerReason: reason },
  });
  return same >= 4;
}

/** Readable text from a listing page, with the furniture stripped. */
function pageText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, noscript, svg").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

export async function scrapeListings(
  businessId: string,
  opts: {
    /** Listing pages to read per source. Each costs one fetch and one model call. */
    perSource?: number;
    sources?: string[];
    /** Collect only listings in this trade. Applied after reading, not before. */
    industry?: string;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<ListingScrapeResult> {
  const out: ListingScrapeResult = {
    sourcesRead: 0, urlsSeen: 0, pagesFetched: 0, created: 0, skipped: [], bySource: {}, costUsd: 0,
  };

  const perSource = opts.perSource ?? 25;
  const sources: Marketplace[] = opts.sources?.length
    ? MARKETPLACES.filter((m) => opts.sources!.includes(m.domain))
    : MARKETPLACES;

  for (const source of [...sources].sort((a, b) => b.weight - a.weight)) {
    const index = await crawlListingIndex(source.domain, { maxUrls: perSource * 2 });
    if (!index.urls.length) {
      out.skipped.push({ url: source.domain, why: index.why });
      continue;
    }
    out.sourcesRead++;
    opts.onProgress?.(`${source.name}: ${index.why}`);

    // Already collected? Re-reading costs a fetch and a model call to learn
    // nothing — a live listing's asking price rarely moves.
    const known = new Set(
      (
        await db.acquisitionTarget.findMany({
          where: { businessId, listingUrl: { in: index.urls } },
          select: { listingUrl: true },
        })
      ).map((t) => t.listingUrl!),
    );

    const todo = index.urls.filter((u) => !known.has(u)).slice(0, perSource);
    out.urlsSeen += index.urls.length;

    for (const url of todo) {
      const res = await politeFetch(url);
      if (!res.ok) {
        out.skipped.push({ url, why: res.reason });
        continue;
      }
      out.pagesFetched++;

      const text = pageText(res.html);
      if (text.length < 300) {
        out.skipped.push({ url, why: "page had almost no readable text" });
        continue;
      }

      const run = await runAgent(
        listingExtractor,
        { url, source: source.name, pageText: text },
        { businessId },
      );
      out.costUsd += run.costUsd;
      const x = run.output;

      // The shape learner finds a marketplace's listing pattern by size, and on
      // some sites the largest group is categories rather than listings. This
      // is where that gets caught, per page, with a reason.
      if (!x.isSingleListing) {
        out.skipped.push({ url, why: `not one listing — ${x.reasoning.slice(0, 70)}` });
        continue;
      }
      // Several of these marketplaces are international. A Slovakian biogas
      // plant is a real listing and still not something to act on from here.
      if (x.country && !/singapore|\bsg\b/i.test(x.country)) {
        out.skipped.push({ url, why: `operates in ${x.country}` });
        continue;
      }
      // These marketplaces carry shop leases beside businesses, and the two
      // read almost identically. One reached the database as a company asking
      // SGD 100, which was a monthly rent.
      if (isPropertyNotBusiness(x.name)) {
        out.skipped.push({ url, why: "premises to rent, not a business" });
        continue;
      }
      if (opts.industry) {
        const hay = `${x.industry ?? ""} ${x.name} ${x.summary}`.toLowerCase();
        if (!hay.includes(opts.industry.toLowerCase())) {
          out.skipped.push({ url, why: `not ${opts.industry}` });
          continue;
        }
      }

      const boilerplate = x.sellerReason
        ? await isBoilerplateReason(businessId, source.name, x.sellerReason)
        : false;

      // The profit figure carries its own caveat. A listing quoting SDE is
      // quoting a number that includes the owner's own salary, so the multiple
      // it implies is not comparable to one built on EBITDA. Recorded rather
      // than silently normalised, because normalising it would be a guess about
      // the number that decides an offer.
      const notes = [
        x.profitTerm && !/\bebitda\b/i.test(x.profitTerm)
          ? `Profit is stated as "${x.profitTerm}", not EBITDA — no multiple computed, the two are not comparable.`
          : null,
        boilerplate
          ? `The listing's stated reason for selling ("${x.sellerReason}") is the same on every listing from ${source.name}, so it is site boilerplate rather than this owner's reason.`
          : null,
        x.isAnonymised ? "Anonymised listing; the business is not named." : null,
        x.hasDirectContact ? null : "No direct contact on the listing — enquiry goes through the marketplace.",
      ]
        .filter(Boolean)
        .join(" ");

      try {
        await db.acquisitionTarget.create({
          data: {
            businessId,
            origin: "LISTED",
            status: "IDENTIFIED",
            name: x.name.slice(0, 200),
            industry: x.industry,
            listingUrl: url,
            listingSource: source.name,
            listingSummary: x.summary,
            // Nulled rather than stored with a caveat: a reason that is not
            // this owner's reason is not a fact about this business, and the
            // note records what happened.
            sellerReason: boilerplate ? null : x.sellerReason,
            currency: x.currency ?? "SGD",
            askingPrice: x.askingPrice,
            revenue: x.revenue,
            ebitda: x.ebitda,
            profitTerm: x.profitTerm,
            askingMultiple: askingMultiple(x.askingPrice, x.ebitda, x.profitTerm),
            employeeCount: x.employeeCount,
            yearsEstablished: x.yearsEstablished,
            notes: notes || null,
          },
        });
        out.created++;
        out.bySource[source.name] = (out.bySource[source.name] ?? 0) + 1;
      } catch {
        // listingUrl is unique — a race or a redirect landing on a URL already
        // held is a skip, not a failure.
        out.skipped.push({ url, why: "already collected" });
      }
    }
  }

  return out;
}
