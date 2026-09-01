import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { registrableDomain } from "@/lib/domain";
import { companyNameFrom, isNonBusiness } from "@/lib/entity";

/**
 * Target discovery: finding companies to scrape, rather than pasting domains.
 *
 * Two sources, because neither alone is sufficient:
 *
 *   overpass   OpenStreetMap. Free, no key, no terms problem — it is a public
 *              API built for exactly this. Excellent for local service
 *              businesses: names, addresses, coordinates. But measured on
 *              Singapore laundries, only ~5% carry a `website` tag, so it finds
 *              companies rather than sites to crawl.
 *
 *   anthropic  Server-side web search. Returns actual websites, which is what
 *              the scraper needs, but requires ANTHROPIC_API_KEY and costs per
 *              run.
 *
 * Used together: Overpass establishes that a business exists and where, web
 * search resolves it to a site. Overpass-only results are still real leads —
 * a name, an address and sometimes a phone is enough to call someone.
 */

export type DiscoveredTarget = {
  name: string;
  website?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lon?: number;
  source: "overpass" | "anthropic" | "google";
  sourceRef: string;
};

export type DiscoverOpts = {
  /** Registrable domains already in the database — never return these again. */
  exclude?: Set<string>;
  /**
   * Search phrasings to run, from the query strategist. Computed once per
   * search and shared by every adapter — each one generating its own would pay
   * for the same model call several times over.
   */
  queries?: string[];
  /** Title words that mark a result as a directory or listicle, not a company. */
  negatives?: string[];
};

export interface SearchAdapter {
  readonly name: string;
  discover(industry: string, region: string, limit: number, opts?: DiscoverOpts): Promise<DiscoveredTarget[]>;
}

/**
 * The heuristic floor, re-exported under its historical name.
 *
 * Real variants now come from the query strategist (src/agents/query-strategist.ts)
 * and reach the adapters through DiscoverOpts.queries. These hardcoded ones are
 * only what a search falls back to when the model is unavailable.
 */
import { heuristicVariants } from "@/agents/query-strategist";
export { heuristicVariants as queryVariants };
const queryVariants = heuristicVariants;

// ---------------------------------------------------------------------------
// Industry -> OSM tags. Free text from a Pairing row has to become a query.
// ---------------------------------------------------------------------------

type OsmRule = { tags?: string[]; words?: string[] };

const OSM_RULES: Array<{ match: RegExp; rule: OsmRule }> = [
  { match: /laundry|linen|dry clean/i, rule: { tags: ["shop=laundry", "shop=dry_cleaning"], words: ["laundry", "launderette", "dry clean"] } },
  { match: /pest/i, rule: { words: ["pest", "termite", "fumigat"] } },
  { match: /cleaning/i, rule: { tags: ["shop=cleaning", "office=cleaning"], words: ["cleaning services", "cleaning service"] } },
  { match: /hvac|aircon|air-con|air condition/i, rule: { tags: ["craft=hvac", "shop=hvac"], words: ["aircon", "air-con", "air condition"] } },
  { match: /florist|floral/i, rule: { tags: ["shop=florist"], words: ["florist", "flower"] } },
  { match: /caterer|catering/i, rule: { tags: ["shop=caterer", "craft=caterer"], words: ["catering", "caterer"] } },
  { match: /bakery|baker/i, rule: { tags: ["shop=bakery"], words: ["bakery"] } },
  { match: /coffee|roaster/i, rule: { tags: ["shop=coffee"], words: ["coffee", "roaster"] } },
  { match: /print|signage/i, rule: { tags: ["shop=printing", "shop=copyshop", "craft=signmaker"], words: ["printing", "signage", "print shop"] } },
  { match: /accounting|bookkeep|audit|tax/i, rule: { tags: ["office=accountant", "office=tax_advisor"], words: ["accounting", "bookkeeping", "tax"] } },
  { match: /legal|law|solicitor|corporate secretarial/i, rule: { tags: ["office=lawyer"], words: ["law", "legal", "advocates"] } },
  { match: /recruit|employment|staffing|hr /i, rule: { tags: ["office=employment_agency"], words: ["recruitment", "manpower", "staffing"] } },
  { match: /insurance/i, rule: { tags: ["office=insurance"], words: ["insurance"] } },
  { match: /it support|software|automation|managed service|developer/i, rule: { tags: ["office=it", "office=company"], words: ["IT solutions", "software", "systems"] } },
  { match: /marketing|advertis|branding|design|creative/i, rule: { tags: ["office=advertising_agency"], words: ["marketing", "creative", "advertising"] } },
  { match: /photograph|video|production studio/i, rule: { tags: ["shop=photo", "craft=photographer"], words: ["photography", "studio", "productions"] } },
  { match: /logistics|freight|forwarder|courier|warehous/i, rule: { tags: ["office=logistics"], words: ["logistics", "freight", "forwarding", "courier"] } },
  { match: /construction|fit-?out|contractor|renovation|interior/i, rule: { tags: ["craft=builder", "office=construction_company", "shop=interior_decoration"], words: ["renovation", "contractor", "interior", "construction"] } },
  { match: /clinic|healthcare|medical|dental|physio/i, rule: { tags: ["amenity=clinic", "amenity=doctors", "amenity=dentist", "healthcare=physiotherapist"], words: ["clinic", "medical", "dental"] } },
  { match: /training|education|tuition/i, rule: { tags: ["amenity=training", "office=educational_institution"], words: ["training", "academy", "learning"] } },
  { match: /real estate|property|leasing/i, rule: { tags: ["office=estate_agent"], words: ["property", "realty", "estate"] } },
  { match: /security/i, rule: { tags: ["office=security"], words: ["security services"] } },
  { match: /waste|recycl/i, rule: { tags: ["amenity=waste_transfer_station", "office=waste_management"], words: ["waste", "recycling", "disposal"] } },
  { match: /furniture|interiors supply/i, rule: { tags: ["shop=furniture"], words: ["furniture"] } },
  { match: /uniform|apparel|textile/i, rule: { tags: ["shop=clothes", "craft=tailor"], words: ["uniform", "apparel", "tailoring"] } },
  { match: /equipment rental|leasing/i, rule: { tags: ["shop=rental", "shop=trade"], words: ["rental", "equipment"] } },
  { match: /landscap|horticultur|plantscap/i, rule: { tags: ["shop=garden_centre", "craft=gardener"], words: ["landscaping", "horticulture", "greenery"] } },
  { match: /travel|event/i, rule: { tags: ["shop=travel_agency", "office=event_management"], words: ["events", "travel"] } },
];

/** Region bounding boxes: south, west, north, east. */
const BBOX: Record<string, [number, number, number, number]> = {
  Singapore: [1.15, 103.6, 1.48, 104.1],
  SG: [1.15, 103.6, 1.48, 104.1],
};

function osmRuleFor(industry: string): OsmRule | null {
  for (const { match, rule } of OSM_RULES) if (match.test(industry)) return rule;
  // Fall back to the first two meaningful words as a name search.
  const STOP = new Set(["and", "the", "for", "services", "service", "companies", "company", "providers", "provider", "operators", "firms", "agencies"]);
  const words = industry
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
  return words.length ? { words: words.slice(0, 2) } : null;
}

class OverpassAdapter implements SearchAdapter {
  readonly name = "overpass";

  async discover(industry: string, region: string, limit: number): Promise<DiscoveredTarget[]> {
    const bbox = BBOX[region] ?? BBOX.Singapore;
    const rule = osmRuleFor(industry);
    if (!rule) return [];

    const box = bbox.join(",");
    const clauses: string[] = [];
    for (const t of rule.tags ?? []) {
      const [k, v] = t.split("=");
      clauses.push(`nwr["${k}"="${v}"](${box});`);
    }
    if (rule.words?.length) {
      const re = rule.words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      clauses.push(`nwr["name"~"${re}",i](${box});`);
    }
    if (!clauses.length) return [];

    const query = `[out:json][timeout:50];\n(\n${clauses.join("\n")}\n);\nout center tags ${Math.min(limit * 4, 300)};`;

    // Overpass is a free, shared, volunteer-run service. 429 and 504 mean the
    // server is busy — back off and retry rather than hammering it or failing.
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 4000 * 2 ** (attempt - 1)));
      res = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": process.env.SCRAPER_USER_AGENT ?? "RevenueAgentBot/0.1",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.ok) break;
      if (res.status !== 429 && res.status !== 504) break;
    }
    if (!res || !res.ok) {
      throw new Error(`Overpass ${res?.status ?? "no response"}: ${((await res?.text()) ?? "").slice(0, 160)}`);
    }

    const json = (await res.json()) as { elements?: Array<{ id: number; type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> };

    const out: DiscoveredTarget[] = [];
    for (const e of json.elements ?? []) {
      const t = e.tags ?? {};
      const name = t.name ?? t["name:en"];
      if (!name) continue; // an unnamed node is not a lead

      // A name search on "clinic" matches bus stops called "Opposite Chung Hwa
      // Free Clinic". Transit infrastructure, roads and buildings are named
      // after nearby businesses constantly, and they are not leads.
      if (t.highway || t.public_transport || t.railway || t.aeroway || t.route) continue;
      if (/^(opposite|opp|bef|aft|before|after|near|outside|beside)\b/i.test(name)) continue;
      if (t.amenity === "bus_station" || t.amenity === "parking" || t.amenity === "shelter") continue;
      // Must look like a business: some classifying tag, or contact details.
      const isBusiness =
        t.shop || t.office || t.craft || t.healthcare || t.company || t.industrial ||
        t.website || t["contact:website"] || t.phone || t["contact:phone"] ||
        (t.amenity && ["clinic", "doctors", "dentist", "pharmacy", "veterinary", "restaurant", "cafe", "training"].includes(t.amenity));
      if (!isBusiness) continue;
      const addr = [t["addr:housenumber"], t["addr:street"], t["addr:unit"], t["addr:postcode"]].filter(Boolean).join(" ");
      out.push({
        name,
        website: t.website ?? t["contact:website"] ?? undefined,
        phone: t.phone ?? t["contact:phone"] ?? undefined,
        address: addr || undefined,
        lat: e.lat ?? e.center?.lat,
        lon: e.lon ?? e.center?.lon,
        source: "overpass",
        sourceRef: `https://www.openstreetmap.org/${e.type}/${e.id}`,
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}

/**
 * Schema-enforced result shape. Asking for JSON in a system prompt and regexing
 * it back out worked most of the time, which is the worst failure mode: the
 * model occasionally answered in prose and the run silently found nothing.
 */
const CompanyList = z.object({
  companies: z.array(
    z.object({
      name: z.string(),
      website: z.string(),
      phone: z.string().nullable(),
    }),
  ),
});

class AnthropicSearchAdapter implements SearchAdapter {
  readonly name = "anthropic";

  async discover(industry: string, region: string, limit: number, opts?: DiscoverOpts): Promise<DiscoveredTarget[]> {
    // Measured: 5 companies ~19s, 8 ~68s, 12 exceeds three minutes. Broad trade
    // queries pull ~50k tokens of search results, and reasoning over them is
    // what costs the time. Rather than one slow call for a long list, run
    // several short ones — same total wall-clock, more unique companies,
    // because each phrasing surfaces a different slice of the market.
    const exclude = opts?.exclude ?? new Set<string>();
    const collected = new Map<string, DiscoveredTarget>();

    // Hard cap on variants. This adapter costs ~70s per phrasing, so running
    // the strategist's full set of nine would block a search for ten minutes —
    // which is exactly how the first deep backfill hung. It is the fallback for
    // when Serper is unavailable, not the volume path, so two phrasings is the
    // right trade between coverage and a search that finishes.
    const VARIANT_CAP = Number(process.env.ANTHROPIC_SEARCH_VARIANT_CAP ?? 2);
    const chosen = (opts?.queries?.length ? opts.queries : queryVariants(industry)).slice(0, VARIANT_CAP);

    for (const variant of chosen) {
      if (collected.size >= limit) break;
      for (const t of await this.one(variant, region, 8, exclude, collected)) {
        const d = registrableDomain(t.website ?? "") ?? t.name.toLowerCase();
        if (!collected.has(d)) collected.set(d, t);
      }
    }
    return [...collected.values()].slice(0, limit);
  }

  private async one(
    industry: string,
    region: string,
    n: number,
    exclude: Set<string>,
    already: Map<string, DiscoveredTarget>,
  ): Promise<DiscoveredTarget[]> {
    const client = new Anthropic({ timeout: 300_000, maxRetries: 0 });

    // Streaming, not create(): a non-streaming request this long hits the HTTP
    // timeout before the model finishes.
    const stream = client.messages.stream({
      model: "claude-sonnet-5",
      max_tokens: 8000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
      output_config: { format: zodOutputFormat(CompanyList) },
      system:
        "Find real companies and report them. The website must be the company's own domain, " +
        "taken from a page you actually opened — never a directory listing, an aggregator, or a " +
        "guess. Omit any company whose site you could not open. Returning fewer, sourced " +
        "companies is correct; padding the list is not.",
      messages: [
        {
          role: "user",
          content:
            `List ${n} ${industry} companies operating in ${region}.` +
            // Excluding by name up front is what stops us paying to rediscover
            // companies already in the database.
            (exclude.size || already.size
              ? `

Do NOT include any of these, they are already known: ` +
                [...new Set([...already.values()].map((a) => a.name).concat([...exclude].slice(0, 60)))]
                  .slice(0, 80)
                  .join(", ")
              : ""),
        },
      ],
    });
    const res = await stream.finalMessage();

    if (res.stop_reason === "refusal") throw new Error("Web search was declined for this query.");

    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");

    let rows: Array<{ name: string; website: string; phone: string | null }>;
    try {
      rows = CompanyList.parse(JSON.parse(text)).companies;
    } catch {
      // Salvage anything complete if the response was cut short.
      const salvaged = parseCompanyRows(text);
      if (!salvaged.length) {
        throw new Error(
          `Web search produced no usable results (stop_reason: ${res.stop_reason}, ${text.length} chars). ` +
            `Try a narrower industry term.`,
        );
      }
      rows = salvaged.filter((r): r is { name: string; website: string; phone: string | null } =>
        Boolean(r.name && r.website),
      ).map((r) => ({ name: r.name, website: r.website, phone: r.phone ?? null }));
    }

    return rows
      .filter((r) => r.name && r.website)
      .map((r) => ({
        name: r.name,
        website: r.website,
        phone: r.phone ?? undefined,
        source: "anthropic" as const,
        sourceRef: r.website,
      }))
      .slice(0, n);
  }
}

type RawRow = { name?: string; website?: string; phone?: string | null };

/**
 * Parses the model's JSON array, salvaging whatever is complete if the response
 * was cut off mid-object. A truncated list of nine good companies is far more
 * useful than throwing all of them away over a missing closing brace.
 */
export function parseCompanyRows(text: string): RawRow[] {
  const block = text.match(/\[[\s\S]*/)?.[0];
  if (!block) return [];

  try {
    const parsed = JSON.parse(block) as RawRow[];
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to salvage
  }

  // Pull out every complete {...} object and parse them individually.
  const rows: RawRow[] = [];
  for (const m of block.matchAll(/\{[^{}]*\}/g)) {
    try {
      rows.push(JSON.parse(m[0]) as RawRow);
    } catch {
      // a genuinely malformed object — skip it
    }
  }
  return rows;
}


/**
 * Google Programmable Search (Custom Search JSON API).
 *
 * Google's index of small local operators is better than anything else
 * available, and it is fast — one HTTP call, no model reasoning, so results
 * come back in under a second rather than the ~78s the web-search route takes.
 *
 * Free tier is 100 queries/day, then $5 per 1,000. Each discover() call uses
 * one query per 10 results requested.
 *
 * The trade: Google returns pages, not companies. A result may be a directory
 * listing, a blog roundup or a competitor's comparison page, so aggregator
 * domains are filtered out and the registrable domain is used as the identity.
 */
export const AGGREGATORS = new Set([
  "google.com", "facebook.com", "instagram.com", "linkedin.com", "youtube.com",
  "carousell.sg", "yelp.com", "tripadvisor.com", "yellowpages.com.sg", "sgpbusiness.com",
  "thesmartlocal.com", "reddit.com", "quora.com", "medium.com", "wikipedia.org",
  "shopee.sg", "lazada.sg", "qanvast.com", "recommend.my", "kaodim.com",
  "streetdirectory.com", "sgcarmart.com", "hardwarezone.com.sg", "seedly.sg",
  "buildersingapore.com", "singsaver.com.sg", "moneysmart.sg", "thehoneycombers.com",
  // Caught in live results: content farms, marketplaces and listicle sites that
  // rank well for trade queries but are not the companies doing the work.
  // News, magazines and blog platforms. A product search ("mooncake") returns
  // mostly editorial coverage rather than businesses — 20 of 54 mooncake
  // results were outlets like these, and no amount of crawling turns a news
  // article into a supplier.
  "channelnewsasia.com", "mothership.sg", "asiaone.com", "straitstimes.com",
  "theindependent.sg", "todayonline.com", "tatlerasia.com", "michelin.com",
  "timeout.com", "augustman.com", "vulcanpost.com", "hypebeast.com",
  "blogspot.com", "wordpress.com", "substack.com", "wixsite.com", "weebly.com",
  "bellyrumbles.com", "omnivorescookbook.com", "danielfooddiary.com",
  // Marketplaces and store platforms — the seller is not the domain owner.
  "amazon.sg", "amazon.com", "myshopify.com", "shopify.com", "etsy.com",
  "ebay.com", "taobao.com", "alibaba.com", "lemon8-app.com", "tiktok.com",
  "pinterest.com", "foursquare.com", "klook.com", "fave.co",
  "sethlui.com", "urbancompany.com", "homees.co", "mrightplumbing.com",
  "besthomerenovation.sg", "trustedsg.com", "sgbestreviews.com", "bestinsingapore.co",
  "funempire.com", "danielfooddiary.com", "tripzilla.com", "timeout.com",
  "expatliving.sg", "honeykidsasia.com", "sgmagazine.com", "yoursingapore.com",
  "servicehero.com.sg", "247homerepair.com.sg", "airtasker.com", "taskrabbit.com",
]);

class GoogleSearchAdapter implements SearchAdapter {
  readonly name = "google";

  async discover(industry: string, region: string, limit: number, opts?: DiscoverOpts): Promise<DiscoveredTarget[]> {
    const key = process.env.GOOGLE_CSE_API_KEY;
    const cx = process.env.GOOGLE_CSE_ID;
    if (!key || !cx) throw new Error("Google search needs GOOGLE_CSE_API_KEY and GOOGLE_CSE_ID in .env");

    const exclude = opts?.exclude ?? new Set<string>();
    const seen = new Map<string, DiscoveredTarget>();
    let queriesUsed = 0;
    const QUERY_BUDGET = 12; // of the 100/day free tier
    const cseNegatives = (opts?.negatives ?? []).map((n) => n.toLowerCase());
    const isDirectory = (title: string) => cseNegatives.some((n) => title.toLowerCase().includes(n));

    // Several phrasings, each paged to Google's 100-result ceiling. One query
    // returns the same twenty well-optimised sites however deep you page.
    outer: for (const variant of (opts?.queries?.length ? opts.queries : queryVariants(industry))) {
      for (let start = 1; start <= 91; start += 10) {
        if (seen.size >= limit || queriesUsed >= QUERY_BUDGET) break outer;

        const url = new URL("https://www.googleapis.com/customsearch/v1");
        url.searchParams.set("key", key);
        url.searchParams.set("cx", cx);
        url.searchParams.set("q", `${variant} ${region}`);
        url.searchParams.set("num", "10");
        url.searchParams.set("start", String(start));

        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        queriesUsed++;
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          if (res.status === 429 || body.includes("Quota")) {
            if (seen.size) break outer; // keep what we have
            throw new Error("Google search daily quota exhausted (100 queries/day on the free tier).");
          }
          if (res.status === 400) break; // past the end of this query's results
          throw new Error(`Google CSE ${res.status}: ${body}`);
        }

        const json = (await res.json()) as {
          items?: Array<{ title: string; link: string; snippet?: string }>;
        };
        if (!json.items?.length) break;

        for (const it of json.items) {
          const domain = registrableDomain(it.link);
          if (!domain || AGGREGATORS.has(domain) || seen.has(domain) || exclude.has(domain)) continue;
          // A listicle that outranks the companies it lists is still one domain
          // and would occupy a lead slot. The strategist names the tells.
          if (isDirectory(it.title)) continue;
          // Regulators and associations rank well for trade terms and are not
          // leads. The Singapore Dental Council reached QUALIFIED before this.
          if (isNonBusiness(domain, it.title)) continue;

          const phone = it.snippet?.match(/(?:\+?65[\s-]?)?[3689]\d{3}[\s-]?\d{4}/)?.[0]?.replace(/[\s-]/g, "");
          seen.set(domain, {
            name: cleanSerpTitle(it.title, domain),
            website: `https://${domain}`,
            phone: phone ? (phone.startsWith("+") ? phone : `+65${phone.slice(-8)}`) : undefined,
            source: "google",
            sourceRef: it.link,
          });
          if (seen.size >= limit) break outer;
        }
      }
    }
    return [...seen.values()];
  }
}


/**
 * Serper — Google's results as JSON.
 *
 * Google's own Custom Search JSON API is closed to new signups and shuts down
 * on 1 January 2027, and "search the entire web" can no longer be enabled on a
 * new Programmable Search Engine, so a self-built CSE only searches sites you
 * list. Serper returns real Google SERPs over one HTTP call instead.
 *
 * 2,500 free credits, then roughly $1 per 1,000. One credit covers up to 10
 * results and two covers up to 100 — so asking for 100 at once is five times
 * cheaper per company than ten separate calls.
 */
class SerperAdapter implements SearchAdapter {
  readonly name = "google";

  async discover(industry: string, region: string, limit: number, opts?: DiscoverOpts): Promise<DiscoveredTarget[]> {
    const key = process.env.SERPER_API_KEY;
    if (!key) throw new Error("Google search needs SERPER_API_KEY in .env (serper.dev — 2,500 free credits).");

    const exclude = opts?.exclude ?? new Set<string>();
    const seen = new Map<string, DiscoveredTarget>();
    const gl = region.toLowerCase().startsWith("sing") ? "sg" : "us";

    // num is ignored — Serper returns ~10 organic results whatever you ask for.
    // Volume comes from paging, one credit per page, so budget it explicitly.
    let credits = 0;
    const CREDIT_BUDGET = Number(process.env.SERPER_CREDIT_BUDGET ?? 24);

    const negatives = (opts?.negatives ?? []).map((n) => n.toLowerCase());
    const isDirectory = (title: string) => {
      const t = title.toLowerCase();
      return negatives.some((n) => t.includes(n));
    };
    const variants = opts?.queries?.length ? opts.queries : queryVariants(industry);

    outer: for (const variant of variants) {
      let emptyPages = 0;
      for (let page = 1; page <= 10; page++) {
        if (seen.size >= limit || credits >= CREDIT_BUDGET) break outer;

        const res = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "X-API-KEY": key, "Content-Type": "application/json" },
          body: JSON.stringify({ q: `${variant} ${region}`, gl, page }),
          signal: AbortSignal.timeout(30_000),
        });
        credits++;

        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          if (res.status === 401 || res.status === 403) {
            throw new Error("SERPER_API_KEY was rejected. Check the key at serper.dev.");
          }
          if (res.status === 429) {
            if (seen.size) break outer;
            throw new Error("Serper credits exhausted. Top up at serper.dev/dashboard.");
          }
          throw new Error(`Serper ${res.status}: ${body}`);
        }

        const json = (await res.json()) as {
          organic?: Array<{ title: string; link: string; snippet?: string }>;
        };
        const items = json.organic ?? [];
        if (!items.length) break; // past the end of this query

        const before = seen.size;
        for (const it of items) {
          const domain = registrableDomain(it.link);
          if (!domain || AGGREGATORS.has(domain) || seen.has(domain) || exclude.has(domain)) continue;
          // A listicle that outranks the companies it lists is still one domain
          // and would occupy a lead slot. The strategist names the tells.
          if (isDirectory(it.title)) continue;

          const phone = it.snippet?.match(/(?:\+?65[\s-]?)?[3689]\d{3}[\s-]?\d{4}/)?.[0]?.replace(/[\s-]/g, "");
          seen.set(domain, {
            name: cleanSerpTitle(it.title, domain),
            website: `https://${domain}`,
            phone: phone ? (phone.startsWith("+") ? phone : `+65${phone.slice(-8)}`) : undefined,
            source: "google",
            sourceRef: it.link,
          });
          if (seen.size >= limit) break outer;
        }

        // Two consecutive pages of nothing new means this phrasing is spent.
        if (seen.size === before) {
          if (++emptyPages >= 2) break;
        } else {
          emptyPages = 0;
        }
      }
    }

    return [...seen.values()];
  }
}

/**
 * A SERP title is a page title with the same SEO stuffing, so it goes through
 * exactly the same rules as a scraped title. This used to be a separate, weaker
 * implementation that accepted "Home" as a company name — and because
 * ingestDomain prefers the search-result name, the weaker one won.
 */
const cleanSerpTitle = companyNameFrom;

export const overpassAdapter = new OverpassAdapter();
export const anthropicSearchAdapter = new AnthropicSearchAdapter();
export const googleSearchAdapter = new GoogleSearchAdapter();
export const serperAdapter = new SerperAdapter();

/**
 * Order matters: Google first when configured, because it is a sub-second HTTP
 * call with the best coverage of small local operators. Anthropic web search is
 * the fallback — far slower (~78s) but needs no extra setup. Overpass last,
 * filling in businesses with no web presence at all.
 */
export function getSearchAdapters(): SearchAdapter[] {
  const adapters: SearchAdapter[] = [];
  // Serper first — real Google results, one call, sub-second.
  if (process.env.SERPER_API_KEY) adapters.push(serperAdapter);
  // Legacy CSE, only for anyone who already had whole-web enabled before Google
  // closed it to new signups. Shuts down 1 Jan 2027.
  else if (process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_ID) adapters.push(googleSearchAdapter);
  if (process.env.ANTHROPIC_API_KEY) adapters.push(anthropicSearchAdapter);
  adapters.push(overpassAdapter);
  return adapters;
}

export function googleConfigured(): boolean {
  return Boolean(process.env.SERPER_API_KEY || (process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_ID));
}
