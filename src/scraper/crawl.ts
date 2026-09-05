import { CONTACT_PATHS, politeFetch } from "./fetcher";
import { extractFromHtml, isRoleBased, type ExtractedContact, type PageExtract } from "./extract";
import { registrableDomain } from "@/lib/domain";
import { companyNameFrom, displayCompanyName } from "@/lib/entity";
import { auditHomepage, unreachableAudit, type SiteAuditResult } from "./audit";

/**
 * Crawls one company's own website for published business contact information.
 *
 * Strategy: homepage first (it usually links everything), then the contact and
 * team paths that actually exist, then any internal link whose slug looks like
 * a contact or people page. Hard-capped - this is a targeted look at a handful
 * of pages, not a site-wide spider.
 */

export type CompanyScrape = {
  domain: string;
  name?: string;
  legalName?: string;
  uen?: string;
  description?: string;
  websiteUrl: string;
  pagesFetched: string[];
  pagesFailed: Array<{ url: string; reason: string }>;
  emails: Array<{ value: string; sourceUrl: string; isRoleBased: boolean }>;
  phones: Array<{ value: string; sourceUrl: string }>;
  people: ExtractedContact[];
  addresses: string[];
  socialLinks: string[];
  /** Concatenated page text, for the model to judge industry and fit. */
  corpus: string;
  /** Set when the site itself said no. Not an error - a valid outcome. */
  blockedBy?: string;
  /** Every page was client-rendered — the data exists but not in raw HTML. */
  jsRendered?: boolean;
  /**
   * Measured properties of the homepage. Computed from HTML already fetched for
   * the contact extraction, so it adds no requests and no tokens.
   */
  audit?: SiteAuditResult;
};

const MAX_PAGES = Number(process.env.SCRAPER_MAX_PAGES ?? 6);
const INTERESTING = /(contact|about|team|people|leadership|management|who-we-are|our-story|company)/i;

export async function crawlCompanySite(input: string): Promise<CompanyScrape | null> {
  const domain = registrableDomain(input);
  if (!domain) return null;

  const base = input.startsWith("http") ? input : `https://${domain}`;
  const result: CompanyScrape = {
    domain,
    websiteUrl: base,
    pagesFetched: [],
    pagesFailed: [],
    emails: [],
    phones: [],
    people: [],
    addresses: [],
    socialLinks: [],
    corpus: "",
  };

  const seen = new Set<string>();
  const extracts: PageExtract[] = [];
  let homeHtml: { html: string; url: string; loadMs: number } | null = null;

  const visit = async (url: string) => {
    const key = url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key) || result.pagesFetched.length >= MAX_PAGES) return;
    seen.add(key);

    const t0 = Date.now();
    const res = await politeFetch(url);
    if (!res.ok) {
      result.pagesFailed.push({ url, reason: res.reason });
      if (res.reason.includes("robots.txt")) result.blockedBy = "robots.txt";
      return;
    }
    // Keep the first page we successfully opened — that is the homepage, and
    // the audit is about what a visitor lands on.
    if (!homeHtml) homeHtml = { html: res.html, url: res.url, loadMs: Date.now() - t0 };
    result.pagesFetched.push(res.url);
    extracts.push(extractFromHtml(res.html, res.url));
  };

  // 1. homepage
  await visit(base);
  if (!result.pagesFetched.length) {
    // Try http:// once — some small business sites still are not on https.
    await visit(base.replace("https://", "http://"));
    if (!result.pagesFetched.length) {
      result.audit = unreachableAudit(
        result.blockedBy ? `blocked by ${result.blockedBy}` : (result.pagesFailed[0]?.reason ?? "unreachable"),
      );
      return result;
    }
  }

  // 2. links the homepage itself offers that look like contact/people pages
  const home = extracts[0];
  const candidates = (home?.internalLinks ?? []).filter((l) => INTERESTING.test(l));
  for (const link of candidates.slice(0, MAX_PAGES - 1)) await visit(link);

  // 3. fall back to conventional paths if we still have room
  if (result.pagesFetched.length < MAX_PAGES) {
    for (const p of CONTACT_PATHS) {
      if (result.pagesFetched.length >= MAX_PAGES) break;
      await visit(`https://${domain}${p}`);
    }
  }

  // ---- merge ----
  const emails = new Map<string, { value: string; sourceUrl: string; isRoleBased: boolean }>();
  const phones = new Map<string, { value: string; sourceUrl: string }>();
  const people = new Map<string, ExtractedContact>();
  const addresses = new Set<string>();
  const social = new Set<string>();

  for (const e of extracts) {
    for (const em of e.emails) {
      // Prefer the address found on a contact page over one in a footer.
      if (!emails.has(em.value) || /contact|team|about/i.test(em.sourceUrl)) emails.set(em.value, em);
    }
    for (const ph of e.phones) if (!phones.has(ph.value)) phones.set(ph.value, ph);
    for (const p of e.people) {
      const existing = p.fullName ? people.get(p.fullName) : undefined;
      if (!existing || (p.email && !existing.email)) people.set(p.fullName!, p);
    }
    e.addresses.forEach((a) => addresses.add(a));
    e.socialLinks.forEach((s) => social.add(s));
  }

  // Attach role-based-domain emails to named people where the site published
  // both but not in the same block. Only when there is exactly one personal
  // (non-role) address — anything else is guesswork.
  const personal = [...emails.values()].filter((e) => !e.isRoleBased);
  if (personal.length === 1 && people.size === 1) {
    const only = [...people.values()][0];
    if (!only.email) only.email = personal[0].value;
  }

  result.jsRendered = extracts.length > 0 && extracts.every((e) => e.likelyJsRendered);
  result.uen = extracts.find((e) => e.uen)?.uen;
  result.legalName = extracts.find((e) => e.legalName)?.legalName;

  // Name preference, best source first.
  //
  // The <title> tag was second in line and is the worst of the three: on a
  // Singapore SME site it is search-engine copy, which is how eleven different
  // firms came to be stored as "Aircon Servicing Singapore". JSON-LD
  // Organization.name is what the business calls itself, and 766 of 977
  // reachable sites publish it — including 72 of the 93 companies whose stored
  // name still collides with somebody else's.
  // Structured data wins only where the title-derived name is generic, not
  // always. Tested against colliding companies: it turns "Aircon Servicing
  // Singapore" into "Mastercool", which is the whole point — but it also turns
  // "Impress Gift" into "Kytelink", which may be a platform or a parent rather
  // than the trading name. Where the title already yields something specific,
  // there is nothing to gain and something to lose.
  const structured = extracts.find((e) => e.structuredName)?.structuredName;
  const fromTitle = companyNameFrom(home?.title, domain);
  const titleIsGeneric = displayCompanyName(fromTitle, domain) !== fromTitle;
  result.name = result.legalName ?? (titleIsGeneric && structured ? structured : fromTitle);
  result.description = home?.description;
  result.emails = [...emails.values()].sort((a, b) => Number(a.isRoleBased) - Number(b.isRoleBased));
  result.phones = [...phones.values()];
  result.people = [...people.values()].sort((a, b) => b.confidence - a.confidence);
  result.addresses = [...addresses];
  result.socialLinks = [...social];
  result.corpus = extracts.map((e) => e.text).join("\n\n").slice(0, 12000);

  // The audit runs on HTML already in memory — no extra request, no tokens.
  const h = homeHtml as { html: string; url: string; loadMs: number } | null;
  if (h) {
    result.audit = auditHomepage(h.html, h.url, {
      loadMs: h.loadMs,
      pagesFetched: result.pagesFetched.length,
      jsRendered: result.jsRendered,
    });
  }

  return result;
}

/**
 * Company naming now lives in src/lib/entity.ts, shared with the search
 * adapter. Re-exported here so existing imports keep working.
 */
export { companyNameFrom };

/** Quality gate — is this scrape worth persisting as a contactable lead? */
export function scrapeQuality(s: CompanyScrape): {
  score: number;
  tier: "CONTACTABLE" | "PARTIAL" | "THIN";
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  const named = s.people.filter((p) => p.email);
  const role = s.emails.filter((e) => e.isRoleBased);
  const personal = s.emails.filter((e) => !e.isRoleBased);

  if (named.length) { score += 50; reasons.push(`${named.length} named contact(s) with an address`); }
  else if (personal.length) { score += 30; reasons.push(`${personal.length} personal address(es), no name attached`); }
  if (role.length) { score += 20; reasons.push(`${role.length} role-based address(es)`); }
  if (s.phones.length) { score += 15; reasons.push("phone published"); }
  if (s.people.length && !named.length) { score += 10; reasons.push(`${s.people.length} named person(s), no address`); }
  if (s.addresses.length) { score += 5; reasons.push("postal address"); }
  if (s.uen) { score += 5; reasons.push(`UEN ${s.uen}`); }

  if (!s.emails.length && !s.phones.length) {
    reasons.push(s.jsRendered ? "no contact route in raw HTML (JavaScript-rendered site)" : "no contact route found");
  }

  const tier = score >= 50 ? "CONTACTABLE" : score >= 20 ? "PARTIAL" : "THIN";
  return { score: Math.min(100, score), tier, reasons };
}
