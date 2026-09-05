/**
 * Where Singapore businesses are advertised for sale.
 *
 * This list is measured, not assumed. Six searches were run through Serper
 * ("businesses for sale in Singapore", "SME for sale Singapore asking price",
 * "aircon servicing business for sale Singapore", and so on) and the domains
 * below are what actually came back, ranked by how often they appeared. It is
 * worth re-running that sweep occasionally — marketplaces close and brokers
 * appear, and a registry that silently goes stale looks exactly like a working
 * one that has nothing to find.
 *
 * Three kinds of source, kept apart because they behave differently:
 *
 *   marketplace — many listings, structured pages, an index worth paging
 *   broker      — a firm's own inventory. Fewer listings, often better ones,
 *                 and a named human to talk to
 *   social      — Facebook groups, Carousell, Instagram. Excluded. They need a
 *                 login, their terms forbid automated collection, and the
 *                 listings are unstructured. Named here so the omission reads
 *                 as a decision rather than an oversight.
 */

export type MarketplaceKind = "marketplace" | "broker";

export type Marketplace = {
  domain: string;
  name: string;
  kind: MarketplaceKind;
  /** How often it surfaced in the measured sweep. Higher first. */
  weight: number;
};

export const MARKETPLACES: Marketplace[] = [
  { domain: "businessforsale.sg", name: "BusinessForSale.sg", kind: "marketplace", weight: 19 },
  { domain: "singapore.businessesforsale.com", name: "BusinessesForSale", kind: "marketplace", weight: 8 },
  { domain: "smergers.com", name: "SMERGERS", kind: "marketplace", weight: 8 },
  { domain: "dealstream.com", name: "DealStream", kind: "marketplace", weight: 6 },
  { domain: "feyday.com", name: "Feyday", kind: "marketplace", weight: 5 },
  { domain: "bizsales.sg", name: "BizSales.sg", kind: "marketplace", weight: 4 },
  { domain: "bizhub.sg", name: "BizHub", kind: "marketplace", weight: 2 },
  { domain: "tobuz.com", name: "Tobuz", kind: "marketplace", weight: 2 },
  { domain: "sbx.com.sg", name: "Singapore Business Exchange", kind: "marketplace", weight: 2 },
  { domain: "sgbusinessmart.com", name: "SG BusinessMart", kind: "marketplace", weight: 1 },
  { domain: "businessexchangesg.com", name: "BusinessExchange SG", kind: "marketplace", weight: 1 },
  { domain: "ebizsurf.com.sg", name: "eBizSurf", kind: "marketplace", weight: 1 },
  { domain: "buysellsingaporebusiness.com", name: "BSSB", kind: "marketplace", weight: 1 },
  { domain: "easybuysellbusiness.com", name: "EasyBuySellBusiness", kind: "marketplace", weight: 1 },

  { domain: "hnsconsult.com", name: "HNS Consult", kind: "broker", weight: 5 },
  { domain: "shkoh.com.sg", name: "SH Koh", kind: "broker", weight: 2 },
  { domain: "lntglobal.com", name: "LNT Global", kind: "broker", weight: 2 },
  { domain: "mergerscorp.com", name: "MergersCorp", kind: "broker", weight: 2 },
  { domain: "sunbeltnetwork.com", name: "Sunbelt Network", kind: "broker", weight: 1 },
  { domain: "theco.sg", name: "The Co", kind: "broker", weight: 1 },
];

/**
 * Sites that carry listings but are not collected from.
 *
 * Kept as data so a future search that surfaces them skips them by rule rather
 * than by whoever is reading the results that day.
 */
export const EXCLUDED_SOURCES: Array<{ domain: string; why: string }> = [
  { domain: "facebook.com", why: "needs a login; automated collection is against its terms" },
  { domain: "instagram.com", why: "needs a login; automated collection is against its terms" },
  { domain: "carousell.sg", why: "terms forbid automated collection" },
  { domain: "reddit.com", why: "discussion, not listings" },
  { domain: "flippa.com", why: "online businesses, almost never Singapore-operating" },
];

/**
 * The queries that find listings on one source for one industry.
 *
 * A site: query rather than a general one, because a general search returns the
 * marketplace's own category pages far more often than it returns listings. The
 * bare-industry variant is there because plenty of listings never say
 * "Singapore" in the body — the marketplace's own country section is what makes
 * them Singaporean, and demanding the word in the text loses them.
 */
export function listingQueries(source: Marketplace, industry: string): string[] {
  const site = `site:${source.domain}`;
  return [
    `${site} ${industry} for sale`,
    `${site} ${industry} Singapore asking price`,
    `${site} ${industry}`,
  ];
}

/** Paths that are a marketplace's own furniture, not somebody's business. */
const INDEX_PATH =
  /\/(search|browse|category|categories|listings?|industr(y|ies)|sectors?|location|about|contact|blog|news|pricing|login|register|sell|sitemap|page)(\/|$|\?)/i;

/**
 * Is this URL one listing, or the shelf it sits on?
 *
 * Index pages outrank listings on almost every one of these sites, so without
 * this the collection fills with category pages that read like listings to an
 * extractor and produce a target named "Food & Beverage Businesses For Sale".
 */
export function looksLikeListing(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const path = u.pathname.replace(/\/+$/, "");
  if (!path || path === "/") return false;
  if (INDEX_PATH.test(path)) return false;
  // A listing URL almost always carries an id or a slug of real length; a
  // section page is short and generic.
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return /\d{3,}/.test(last) || last.split("-").length >= 3;
}
