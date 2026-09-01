/**
 * Naming and entity rules, in one place.
 *
 * These lived in two copies — `companyNameFrom` in the crawler and
 * `cleanSerpTitle` in the search adapter — with different rules. The crawler's
 * copy correctly rejected "Home" as a page title; the search adapter's did not,
 * and because `ingestDomain` prefers the search-result name over the scraped
 * one, the weaker copy won. Six companies entered the pipeline named "Home".
 *
 * Two implementations of the same rule is how that happens, so there is now one.
 */

/** Page furniture that is a nav label, not a company. */
const PAGE_TITLES =
  /^(https?|www|store locator|locations?|stores?|contact( us)?|about( us)?|home ?page?|home|overview|welcome|products?|services?|our services|shop|menu|blog|news|articles?|faqs?|privacy|terms|cart|checkout|login|sign in|search results?|page not found|404|untitled|index|main|dashboard|gallery|portfolio|testimonials|reviews)$/i;

/** Markers that a title is marketing copy rather than a name. */
const SEO_NOISE =
  /[#$!]|from \$|\bbest\b|\bcheap\b|\bfast\b|\btop\b|no\.?\s*1|#1|affordable|trusted|leading|\bprice\b|per unit|\d+%|24\/7|singapore's/i;

/** Separators that divide a page title into segments. */
const SEP = /\s+[-–—]\s+|[|·»:]|\s+\|\s+/;

/**
 * Organisations that cannot be sold to or brokered.
 *
 * The Singapore Dental Council reached QUALIFIED status and sat in four
 * introductions. A regulator is not a lead; emailing one under a commercial
 * pitch is the kind of mistake that is remembered.
 */
const NON_BUSINESS_TLD = /\.(gov|edu|mil)(\.[a-z]{2})?$/i;
const NON_BUSINESS_NAME =
  /\b(council|authority|ministry|association|society|federation|statutory board|institute|university|polytechnic|academy of|chamber of commerce|government|regulator|tribunal|commission)\b/i;
const NON_BUSINESS_DOMAIN =
  /(wikipedia|wikimedia|linkedin|facebook|instagram|glassdoor|indeed|jobstreet|jobsdb|mycareersfuture)\./i;

/**
 * A site that lists other businesses is not a business you can broker.
 *
 * healthcare.com.sg was classified as a dental clinic, scored 86/100, and sat
 * in 27 introductions. It is a healthcare directory. The domain looks like a
 * company and the name gives nothing away — the only tell is what the site says
 * about itself, which is why this reads the description rather than the URL.
 *
 * The patterns are deliberately narrow. A looser first attempt also flagged a
 * real gift shop ("find the best gifts for...") and a real service company,
 * and wrongly rejecting a genuine lead is a worse error than letting one
 * directory through.
 */
const DIRECTORY_SELF_DESCRIPTION: Array<[RegExp, string]> = [
  [/\bdirector(?:y|ies)\b/i, "calls itself a directory"],
  [/\bmarketplace\b/i, "calls itself a marketplace"],
  [/\bbusiness portal\b/i, "calls itself a business portal"],
  [/\baggregator\b/i, "calls itself an aggregator"],
  [/\blist your business\b/i, "invites businesses to list themselves"],
  [/\bcompare (?:quotes|prices|providers|suppliers|contractors)\b/i, "offers quote comparison"],
  [/\bsearch (?:for )?(?:thousands|hundreds) of\b/i, "advertises a searchable database of other companies"],
];

export function isDirectorySite(description: string | null | undefined): false | string {
  if (!description) return false;
  for (const [re, why] of DIRECTORY_SELF_DESCRIPTION) {
    const m = description.match(re);
    if (m) return `${why} ("${m[0].trim()}")`;
  }
  return false;
}

export function isNonBusiness(domain: string | null | undefined, name?: string | null): false | string {
  const d = (domain ?? "").toLowerCase();
  if (d && NON_BUSINESS_TLD.test(d)) return "government or education domain";
  if (d && NON_BUSINESS_DOMAIN.test(d)) return "platform or job board, not a company";
  if (name && NON_BUSINESS_NAME.test(name)) return "regulator, association or institution";
  return false;
}

/**
 * Words that appear glued together in Singapore SME domains. Used to turn
 * "singaporedentalspecialists" into "Singapore Dental Specialists" rather than
 * "Singaporedentalspecialists", which reads like a typo in an email greeting.
 *
 * Longest-first so "specialists" wins over "special".
 */
const DOMAIN_WORDS = [
  "singapore", "specialists", "specialist", "engineering", "maintenance", "solutions", "solution",
  "corporate", "servicing", "services", "service", "aircon", "air-con", "dental", "clinic", "clinics",
  "surgery", "medical", "health", "healthcare", "flowers", "flower", "florist", "chocolate", "gifts",
  "gift", "premium", "premiums", "laundry", "linen", "cleaning", "cleaner", "pest", "control",
  "group", "holdings", "trading", "supply", "supplies", "systems", "system", "technology", "tech",
  "digital", "studio", "design", "print", "printing", "logistics", "express", "global", "asia",
  "international", "enterprise", "enterprises", "industries", "industrial", "contractor",
  "contractors", "builders", "renovation", "interior", "consultancy", "consulting", "partners",
  "associates", "management", "marketing", "creative", "agency", "works", "smile", "smiles",
  "teeth", "tooth", "care", "centre", "center", "family", "kids", "best", "pro", "plus", "hub",
  "point", "world", "house", "home", "shop", "store", "online", "direct", "first", "prime", "star",
].sort((a, b) => b.length - a.length);

/**
 * Split a run-together domain stem into words.
 *
 * Greedy longest-match is the obvious approach and it is wrong:
 * "dentalclinicsingapore" takes "dental", then prefers "clinics" over "clinic"
 * because it is longer, and strands "ingapore". Choosing the longest word at
 * each step is not the same as choosing the best split of the whole string.
 *
 * So this maximises total matched characters across the whole stem instead,
 * which finds dental + clinic + singapore.
 */
function segment(stem: string): string | null {
  const s = stem.toLowerCase();
  const n = s.length;

  // best[i] = the most characters matchable in s[i..], with the word chosen at i.
  const best = new Array<number>(n + 1).fill(0);
  const pick = new Array<string | null>(n + 1).fill(null);

  for (let i = n - 1; i >= 0; i--) {
    // Option 1: treat s[i] as unmatched filler.
    let bestScore = best[i + 1];
    let bestWord: string | null = null;

    // Option 2: any dictionary word starting here.
    for (const w of DOMAIN_WORDS) {
      if (!s.startsWith(w, i)) continue;
      const score = w.length + best[i + w.length];
      if (score > bestScore) {
        bestScore = score;
        bestWord = w;
      }
    }
    best[i] = bestScore;
    pick[i] = bestWord;
  }

  const matched = best[0];
  if (matched / n < 0.6) return null;

  // Walk the choices, collecting words and runs of filler.
  const parts: string[] = [];
  let i = 0;
  let filler = "";
  while (i < n) {
    const w = pick[i];
    if (w) {
      if (filler) { parts.push(filler); filler = ""; }
      parts.push(w);
      i += w.length;
    } else {
      filler += s[i];
      i++;
    }
  }
  if (filler) parts.push(filler);

  // A stub fragment is the clearest tell that the split is wrong:
  // "singaporeaircond" would give "Singapore Aircon D", which reads as a typo.
  if (parts.length < 2) return null;
  if (parts.some((p) => p.length < 3)) return null;
  return parts.map(title).join(" ");
}

const title = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);

/** A readable company name derived from the domain alone. */
export function nameFromDomain(domain: string): string {
  const stem = domain.split(".")[0];
  if (!stem) return domain;

  if (/[-_]/.test(stem)) {
    return stem.split(/[-_]+/).filter(Boolean).map(title).join(" ");
  }
  return segment(stem) ?? title(stem);
}

/**
 * The company's name, from a page title or SERP title, falling back to the
 * domain when the title is furniture or marketing copy.
 */
export function companyNameFrom(rawTitle: string | undefined, domain: string): string {
  // A URL is never a company name, and splitting one on ":" yields "https".
  if (rawTitle && /^\s*(https?:\/\/|www\.)/i.test(rawTitle)) return nameFromDomain(domain);

  const usable = (t: string | undefined) =>
    Boolean(t && t.length > 2 && t.length <= 42 && !PAGE_TITLES.test(t.trim()) && !SEO_NOISE.test(t));

  const segments = (rawTitle ?? "").split(SEP).map((p) => p.trim()).filter(Boolean);

  const first = segments[0];
  if (usable(first)) return first;

  const alt = segments.find(usable);
  if (alt) return alt;

  return nameFromDomain(domain);
}

// ---------------------------------------------------------------------------
// Email attribution
// ---------------------------------------------------------------------------

/** Providers where a business legitimately hosts its mail. */
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.sg", "hotmail.co.uk",
  "yahoo.com", "yahoo.com.sg", "yahoo.com.hk", "outlook.com", "outlook.sg",
  "live.com", "live.com.sg", "icloud.com", "me.com", "aol.com", "qq.com", "163.com",
]);

/** Singapore ISPs that host small-business mailboxes. Legitimate, not foreign. */
const ISP_MAIL = new Set([
  "singnet.com.sg", "pacific.net.sg", "starhub.net.sg", "m1.com.sg", "magix.com.sg",
]);

export type EmailScope = "own_domain" | "freemail" | "isp" | "foreign";

/**
 * Whose mailbox is this?
 *
 * An address on the company's own domain, on a free provider, or on a local ISP
 * is theirs. An address on a DIFFERENT business domain usually is not — it is a
 * partner, a parent group, the web designer, or a directory embed the crawler
 * picked up. Measured across 435 companies: 253 addresses sat on another
 * business domain, and spot-checking found `astonair@singnet.com.sg` attached to
 * daikin.com.sg and `giovanni.catbagan@oom.com.sg` attached to newway.sg.
 *
 * Sending to those puts the wrong company's name in front of a stranger, so a
 * foreign address is kept as evidence and never used as a send route.
 */
export function emailScope(email: string, companyDomain: string | null | undefined): EmailScope {
  const e = email.toLowerCase().trim();
  const eDomain = e.split("@")[1] ?? "";
  if (!eDomain) return "foreign";
  if (FREEMAIL.has(eDomain)) return "freemail";
  if (ISP_MAIL.has(eDomain)) return "isp";

  const cd = (companyDomain ?? "").toLowerCase();
  if (!cd) return "foreign";

  // Punctuation is not identity: fidecs-engineering.com and
  // fidecsengineering.com are the same firm, and comparing the raw stems marked
  // the company's own address as somebody else's.
  const flatten = (d: string) => d.split(".")[0].replace(/[-_]/g, "");
  const cStem = flatten(cd);
  const eStem = flatten(eDomain);
  if (!cStem) return "foreign";

  // Same registrable domain, or one stem contains the other — covers
  // company.com.sg vs company.sg, and shop.company.com.
  if (eDomain === cd || eDomain.endsWith(`.${cd}`) || cd.endsWith(`.${eDomain}`)) return "own_domain";
  // Require a real overlap: a 3-character stem inside a long one is a
  // coincidence, not a match.
  const shorter = cStem.length <= eStem.length ? cStem : eStem;
  if (shorter.length >= 5 && (eStem.includes(cStem) || cStem.includes(eStem))) return "own_domain";

  return "foreign";
}

/** Can this address be used to actually send? */
export const isSendable = (scope: EmailScope) => scope !== "foreign";


/**
 * Decide which of a company's scraped addresses can actually be mailed.
 *
 * `emailScope` judges one address in isolation, which is not enough for ISP
 * mailboxes. A one-person aircon firm on `singnet.com.sg` is legitimately
 * reachable there. But daikin.com.sg yielded SEVEN singnet addresses —
 * astonair@, taiwahaircon@, fongsang@, cappitec@ — which is Daikin's dealer
 * list scraped off their own site, not Daikin's inbox. Mailing those as if they
 * were Daikin is the wrong-company failure this whole check exists to stop.
 *
 * So an ISP address is a route only when there are few of them. Volume is the
 * tell that the page was a directory.
 */
const MAX_ISP_ADDRESSES = 2;

export function sendableEmails<T extends { value: string }>(
  emails: T[],
  companyDomain: string | null | undefined,
): { sendable: T[]; rejected: Array<{ email: T; reason: string }> } {
  const scoped = emails.map((e) => ({ email: e, scope: emailScope(e.value, companyDomain) }));
  const ispCount = scoped.filter((x) => x.scope === "isp").length;
  const ispIsDirectory = ispCount > MAX_ISP_ADDRESSES;

  const sendable: T[] = [];
  const rejected: Array<{ email: T; reason: string }> = [];

  for (const { email, scope } of scoped) {
    if (scope === "foreign") {
      rejected.push({ email, reason: `on another company's domain, not ${companyDomain}` });
    } else if (scope === "isp" && ispIsDirectory) {
      rejected.push({ email, reason: `one of ${ispCount} ISP addresses on this page — a dealer or partner list` });
    } else {
      sendable.push(email);
    }
  }
  return { sendable, rejected };
}
