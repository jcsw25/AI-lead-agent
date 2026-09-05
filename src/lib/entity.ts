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
 * Words that describe a page rather than name a company.
 *
 * A name made entirely of these is a scraped heading, not a business.
 */
const HEADING_WORDS = new Set([
  "our", "the", "and", "&", "us", "we", "your",
  "services", "service", "capabilities", "capability", "solutions", "products", "product",
  "about", "contact", "home", "welcome", "overview", "profile", "company", "companies",
  "expertise", "offerings", "works", "portfolio", "gallery", "info", "information",
  "page", "site", "website", "main", "index",
  // "Get in Touch" reached the pitch list as a company name.
  "get", "touch", "in", "here", "more", "learn", "read", "view", "see",
]);

/**
 * Names that are an article headline rather than a business.
 *
 * "The Vital Role of Elevator Maintenance" was ranked #6 in the pitch list as
 * though it were a company. It is a blog post title, and the heading-words test
 * cannot catch it because "vital", "role" and "elevator" are all real words a
 * company might use. The shape is the tell: an English sentence with an article
 * and a preposition in it, which company names almost never have.
 */
const ARTICLE_TITLE =
  /^(the|a|an|why|how|what|when|where|top \d+|\d+ (?:ways|tips|reasons|things))\b.*\b(of|for|to|in|that|your|you)\b/i;

/**
 * A name fit to put in an email, or null if the row has none.
 *
 * PAGE_TITLES only matches a title that is EXACTLY a page name, so "OUR
 * SERVICES & CAPABILITIES" walked past it at ingest and reached a live draft —
 * an email that told the recipient it had "ended up on your Our Services &
 * Capabilities page". A name made of nothing but heading words is checked here
 * as a whole rather than against a fixed list, because the combinations are
 * endless and the words are few.
 *
 * The optional industry catches the other failure: a name identical to the
 * trade itself. Searching "aircon" produced several companies literally called
 * "Aircon Servicing Singapore", an SEO heading every firm in the trade shares.
 * Both cases fall back to the domain, which is what the owner registered and so
 * closer to what they call themselves.
 */
export function displayCompanyName(
  name: string,
  domain: string | null | undefined,
  industry?: string,
): string | null {
  const words = name.toLowerCase().split(/[\s,/&-]+/).filter(Boolean);
  const allHeading = words.length > 0 && words.every((w) => HEADING_WORDS.has(w));
  const isArticle = words.length >= 4 && ARTICLE_TITLE.test(name);

  // A name is generic only when NOTHING distinctive is left once the trade and
  // the filler words are removed.
  //
  // The looser test — "the name contains the industry" — was measured over the
  // whole database and was badly wrong. It wanted to rename "24Hrs Florist" to
  // "24hrscityflorist", "Kong Dental Clinic & Surgery" to "Kong Dental", and
  // "Hershey's Chocolate World" to "Rwsentosa", which is the shopping centre
  // the shop sits in. Containing the word "florist" does not make a florist's
  // name generic; being nothing BUT the word florist does.
  const FILLER = /\b(pte|ltd|llp|limited|singapore|sg|the|and|co|company|services?|servicing|in|of|for|general|best|top|professional|expert|specialists?)\b/g;

  // Stemmed, because the unstemmed comparison left ten different corporate gift
  // companies all called "Corporate Gifts Singapore": the industry is "corporate
  // gifting", the name says "gifts", and "gifts" is not "gifting" to a string
  // comparison. Crude suffix stripping is enough — this only has to tell a
  // trade word from a brand name.
  const stem = (w: string) => {
    for (const suffix of ["ings", "ing", "ers", "er", "ies", "es", "s"]) {
      if (w.length > suffix.length + 2 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
    }
    return w;
  };
  const distinctive = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(FILLER, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map(stem);

  const indWords = new Set(industry ? distinctive(industry) : []);
  const leftover = distinctive(name).filter((w) => !indWords.has(w));

  const genericForTrade = indWords.size > 0 && leftover.length === 0;

  if (!allHeading && !genericForTrade && !isArticle) return name;
  if (!domain) return null;

  // The domain is only an improvement if it says something the old name did
  // not. A domain that reduces to the trade itself is no better than the
  // heading it would replace.
  const derived = nameFromDomain(domain);
  const derivedLeft = distinctive(derived).filter((w) => !indWords.has(w));
  if (indWords.size > 0 && derivedLeft.length === 0) return null;
  return derived;
}

/** Mailbox words that are a function, not a person. */
const MAILBOX_WORDS =
  /^(info|enquir(y|ies)|inquiry|contact|sales|support|prosupport|admin|office|hello|hi|help|service|services|feedback|marketing|general|team|mail|email|ask|booking|bookings|customerservice|cs|reception)$/i;

/**
 * Is there a real person behind this contact, or just a shared mailbox?
 *
 * This matters more here than it looks. Contact names are derived from the
 * email local part or the page title, so the stored "full name" for a Singapore
 * aircon firm is routinely "prosupport", "feedback", "chanbro",
 * "airconexpresssg" or "Coolaircon (hello)". The outreach writer took the first
 * word of that and greeted people with "Hi Bond," and would have written "Hi
 * feedback," — worse than not using a name at all, because it proves nobody
 * looked.
 *
 * It is also not an edge case. Across 841 companies collected, exactly zero
 * publish a named member of staff. A role inbox is the normal case in this
 * market, so "Hi there," is the normal correct greeting.
 */
export function isRoleInbox(
  fullName: string | null | undefined,
  jobTitle: string | null | undefined,
  companyName?: string | null,
): boolean {
  if (!fullName?.trim()) return true;
  if (!jobTitle || /^general enquiries$/i.test(jobTitle)) return true;

  const name = fullName.trim();
  // "Coldway Aircon: Home (hello)" — the parenthesis is the mailbox it came from.
  if (/[(:]/.test(name)) return true;

  const words = name.split(/\s+/);
  // A single token is a handle, not a name. Real names have a space.
  if (words.length === 1) return true;
  if (words.some((w) => MAILBOX_WORDS.test(w))) return true;

  if (companyName) {
    const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (flat(name).includes(flat(companyName)) || flat(companyName).includes(flat(name))) return true;
  }
  return false;
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
