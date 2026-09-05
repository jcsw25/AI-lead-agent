import * as cheerio from "cheerio";
import { politeFetch } from "@/scraper/fetcher";

/**
 * Finding the listings on a marketplace by reading its own index.
 *
 * The obvious approach was Google, and it was tried and measured first:
 * `site:businessforsale.sg aircon for sale` returned routledge.com/sale,
 * abercrombie.com/shop/us/sale and a US federal oil-and-gas lease auction.
 * Google silently drops the site: operator when a domain has little matching
 * indexed content and answers the rest of the query instead — so the results
 * were not merely thin, they were confidently about something else. Of six
 * sources searched, one produced a usable listing URL.
 *
 * Reading the marketplace's own browse page has none of that problem. The index
 * links to every listing it has, which is the entire purpose of an index.
 *
 * The shape of a listing URL differs per site — /businesses-for-sale/34747 on
 * one, /business/koto-specialty-coffee-bugis on another, /directory/business/…
 * on a third — so rather than hardcode twenty patterns that rot silently, the
 * shape is learned: group every link by its path skeleton, then pick the group
 * that looks like listings. A marketplace's listings are always its largest
 * group of same-shaped deep links, because that is what a marketplace is.
 */

export type IndexCrawlResult = {
  /** The learned URL skeleton, kept so a wrong guess is visible rather than silent. */
  shape: string | null;
  urls: string[];
  indexPagesRead: number;
  why: string;
};

/** Where a browse page usually lives. Cheap to try, and misses cost one fetch. */
const INDEX_PATHS = [
  "/",
  "/businesses-for-sale",
  "/business-for-sale",
  "/listings",
  "/all-listings",
  "/browse",
  "/buy-a-business",
  "/search",
];

/** First path segments that mark a group as listings. */
const LISTING_WORDS = /^(businesses?|listings?|compan(y|ies)|directory|opportunit|deals?|for-sale|business-for-sale|businesses-for-sale)/i;

/**
 * First path segments that are never a business for sale.
 *
 * Each of these was seen in the measured crawl. "businesses-sold" is the one
 * that matters most: it is the same shape as the live listings, sits on the
 * same site, and every entry in it has already been sold.
 */
const NOT_LISTINGS =
  /^(blogs?|posts?|news|pages?|articles?|cdn-cgi|register-login|login|account|cart|category|categories|single-category|at_biz_dir-category|tag|author|wp-|franchise|properties?-for-sale|commercial|businesses-sold|sold|services?|about|contact|privacy|terms|sitemap|feed)/i;

/** The path skeleton of a URL: first segment kept, the rest reduced to depth. */
function shapeOf(pathname: string): string | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length < 2) return null; // a top-level page is site furniture
  return `/${segs[0]}/${"*/".repeat(segs.length - 2)}*`;
}

function firstSegment(shape: string): string {
  return shape.split("/").filter(Boolean)[0] ?? "";
}

/**
 * How much a group of same-shaped links looks like a marketplace's listings.
 *
 * Size carries most of the weight because that is the honest signal — an index
 * exists to link to everything it has — but a named segment breaks the ties
 * that size alone gets wrong.
 */
function scoreShape(shape: string, count: number): number {
  const seg = firstSegment(shape);
  if (NOT_LISTINGS.test(seg)) return -1;
  let score = count;
  if (LISTING_WORDS.test(seg)) score += 40;
  // Deeply nested links are usually taxonomy rather than items.
  if (shape.split("*").length > 3) score -= 10;
  return score;
}

export async function crawlListingIndex(
  domain: string,
  opts: { maxIndexPages?: number; maxUrls?: number } = {},
): Promise<IndexCrawlResult> {
  const maxIndexPages = opts.maxIndexPages ?? 8;
  const maxUrls = opts.maxUrls ?? 60;

  const groups = new Map<string, Set<string>>();
  const paginated = new Set<string>();
  let indexPagesRead = 0;

  const readPage = async (url: string) => {
    const r = await politeFetch(url);
    if (!r.ok) return false;
    indexPagesRead++;
    const $ = cheerio.load(r.html);
    for (const a of $("a[href]").toArray()) {
      const raw = $(a).attr("href") ?? "";
      let abs: URL;
      try {
        abs = new URL(raw, `https://${domain}`);
      } catch {
        continue;
      }
      if (!abs.hostname.endsWith(domain.replace(/^www\./, ""))) continue;
      // Page 2 of the same index is more listings, so it is worth following —
      // but only a couple, or a paginated site becomes an unbounded crawl.
      if (/[?&]page=\d|\/page\/\d/.test(abs.href) && paginated.size < 3) paginated.add(abs.href);

      const shape = shapeOf(abs.pathname);
      if (!shape) continue;
      const set = groups.get(shape) ?? new Set<string>();
      // Query strings on a listing URL are filters and tracking, not identity.
      set.add(`${abs.origin}${abs.pathname}`);
      groups.set(shape, set);
    }
    return true;
  };

  for (const p of INDEX_PATHS.slice(0, maxIndexPages)) {
    await readPage(`https://${domain}${p}`);
  }
  if (indexPagesRead === 0) {
    return { shape: null, urls: [], indexPagesRead: 0, why: "no index page could be read" };
  }
  for (const p of paginated) await readPage(p);

  const ranked = [...groups.entries()]
    .map(([shape, urls]) => ({ shape, urls: [...urls], score: scoreShape(shape, urls.size) }))
    .filter((g) => g.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.urls.length < 3) {
    return {
      shape: null,
      urls: [],
      indexPagesRead,
      why: "no group of same-shaped links looked like listings",
    };
  }

  return {
    shape: best.shape,
    urls: best.urls.slice(0, maxUrls),
    indexPagesRead,
    why: `${best.urls.length} links shaped ${best.shape}`,
  };
}
