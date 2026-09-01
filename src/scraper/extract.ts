import * as cheerio from "cheerio";

/**
 * Extracts business contact information from a page.
 *
 * Everything returned carries the URL it came from - the provenance rule from
 * ADR-003 is enforced at the point of extraction, not bolted on later. A datum
 * with no source never enters the graph and can never enter an email.
 *
 * Deliberately conservative: it would be easy to guess `firstname.lastname@domain`
 * and inflate the hit rate. Guessed addresses bounce, burn sending reputation,
 * and are exactly the kind of fabricated data this architecture exists to
 * prevent. If it isn't on the page, it isn't returned.
 */

export type ExtractedContact = {
  fullName?: string;
  jobTitle?: string;
  email?: string;
  phone?: string;
  sourceUrl: string;
  confidence: number;
};

export type PageExtract = {
  url: string;
  title?: string;
  description?: string;
  emails: Array<{ value: string; sourceUrl: string; isRoleBased: boolean }>;
  phones: Array<{ value: string; sourceUrl: string }>;
  people: ExtractedContact[];
  addresses: string[];
  socialLinks: string[];
  internalLinks: string[];
  /** Singapore registry number, when the company publishes it. */
  uen?: string;
  /** Registered legal name, e.g. "GreenCool Air-Condition Pte Ltd". */
  legalName?: string;
  /** Raw visible text, capped — fed to the model for judgement calls. */
  text: string;
  /**
   * True when the HTML is large but carries almost no text — a client-rendered
   * SPA. Its contact details exist, just not in the initial response, so an
   * empty extract here means "needs a browser", not "no data".
   */
  likelyJsRendered: boolean;
};

const ROLE_PREFIXES = [
  "info", "hello", "enquiry", "enquiries", "inquiry", "contact", "sales",
  "admin", "office", "support", "ops", "operations", "hr", "careers",
  "marketing", "procurement", "accounts", "finance", "general", "ask", "team",
  // SME service businesses overwhelmingly use these, and misreading one as a
  // person's name produces "Hi service," in the opening line.
  "service", "services", "booking", "bookings", "appointment", "appointments",
  "cs", "customercare", "customerservice", "help", "helpdesk", "mail", "email",
  "reception", "front", "desk", "quote", "quotes", "order", "orders", "shop",
];

const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;

/**
 * Minified and poorly-spaced HTML glues text together, so a naive match yields
 * "hello@prisma.iomake". Validating the final label against real TLDs (and
 * truncating to the longest one that fits) recovers the real address.
 */
const TLDS = new Set([
  "com","org","net","edu","gov","mil","int","io","ai","co","me","tv","cc","biz","info",
  "dev","app","xyz","site","online","store","tech","agency","studio","group","company",
  "sg","my","id","th","vn","ph","hk","tw","jp","kr","cn","in","au","nz","uk","ie",
  "us","ca","de","fr","nl","es","it","se","no","fi","dk","ch","at","be","pl","pt","cz",
  "ae","sa","za","br","mx","ar","cl","tr","ru","il","asia","global","world","email",
]);

function fixTld(domain: string): string | null {
  const labels = domain.split(".");
  const last = labels[labels.length - 1].toLowerCase();
  if (TLDS.has(last)) return domain;
  // Longest known TLD that the label starts with wins: "iomake" -> "io"
  const candidates = [...TLDS].filter((t) => last.startsWith(t)).sort((a, b) => b.length - a.length);
  if (!candidates.length) return null;
  labels[labels.length - 1] = candidates[0];
  return labels.join(".");
}
const PLACEHOLDER = /^(you|your|name|email|user|example|test|sample|domain|someone)@/i;

/**
 * Job titles, matched on WORD BOUNDARIES. Substring matching was finding "lead"
 * inside "leading aircon servicing company" and inventing a person from a
 * marketing headline.
 */
const TITLE_WORDS = [
  "ceo", "cto", "coo", "cfo", "cmo", "founder", "co-founder", "owner",
  "director", "managing director", "general manager", "manager", "head of",
  "chief", "principal", "partner", "president", "vice president", "vp",
  "supervisor", "executive", "officer", "controller", "proprietor",
];

/**
 * Words that mean a Title Case phrase is a company, a service or a headline -
 * not a person. Without this the extractor confidently reports "Gas Top Up"
 * and "Aircon Chemical Wash" as decision makers, which would poison the
 * database that the whole business depends on.
 */
const NOT_A_PERSON = [
  // legal forms
  "pte", "ltd", "llp", "llc", "inc", "corp", "corporation", "company", "co",
  "holdings", "group", "enterprise", "enterprises", "partners", "associates",
  // service and product nouns
  "service", "services", "servicing", "repair", "repairs", "installation",
  "maintenance", "cleaning", "wash", "cooling", "heating", "aircon", "air",
  "conditioning", "solutions", "systems", "supply", "supplies", "equipment",
  "package", "packages", "pricing", "price", "quote", "quotation", "booking",
  "warranty", "guarantee", "gas", "chemical", "overhaul", "steam", "duct",
  // page furniture
  "contact", "about", "home", "menu", "read", "more", "learn", "click",
  "recommended", "insufficient", "frequently", "asked", "questions", "faq",
  "why", "how", "what", "where", "when", "our", "your", "the", "free", "best",
  "top", "new", "get", "book", "call", "whatsapp", "email", "terms", "privacy",
  "policy", "review", "reviews", "testimonial", "testimonials", "blog", "news",
];

function isNotAPerson(name: string): boolean {
  const words = name.toLowerCase().replace(/[^a-z\s-]/g, "").split(/[\s-]+/);
  return words.some((w) => NOT_A_PERSON.includes(w));
}

export function isRoleBased(email: string): boolean {
  const local = email.split("@")[0].toLowerCase();
  return ROLE_PREFIXES.some((p) => local === p || local.startsWith(p + ".") || local.startsWith(p + "-"));
}

function cleanEmail(raw: string): string | null {
  let e = raw.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) return null;
  if (JUNK_EMAIL.test(e) || PLACEHOLDER.test(e)) return null;
  if (e.includes("sentry.io") || e.includes("wixpress") || e.includes("@2x")) return null;

  const [local, domain] = e.split("@");
  const fixedDomain = fixTld(domain);
  if (!fixedDomain) return null;
  // A local part longer than the RFC max, or containing no plausible break,
  // is almost always two run-together strings. Drop rather than guess.
  if (local.length > 64) return null;
  e = `${local}@${fixedDomain}`;
  return e;
}

/** Singapore-first but not Singapore-only: also accepts general international forms. */
function cleanPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.length < 8 || digits.length > 16) return null;
  if (/^\+?65[3689]\d{7}$/.test(digits)) return digits.startsWith("+") ? digits : `+65${digits.slice(-8)}`;
  if (/^[3689]\d{7}$/.test(digits)) return `+65${digits}`;
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  return null;
}

function looksLikeName(s: string): boolean {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length < 5 || t.length > 40) return false;
  const words = t.split(" ");
  if (words.length < 2 || words.length > 4) return false;
  // Title Case words, allowing Tan Wei-Ming and O'Brien
  if (!words.every((w) => /^[A-Z][a-zA-Z'’\-.]{1,}$/.test(w))) return false;
  if (isNotAPerson(t)) return false;
  // ALL CAPS is a heading, not a name
  if (t === t.toUpperCase()) return false;
  return true;
}

/** Word-boundary title match. Returns the matched title, not surrounding prose. */
function findTitleNear(text: string): string | undefined {
  const hit = TITLE_WORDS
    .filter((t) => new RegExp(`\b${t.replace(/[-]/g, "[- ]")}\b`, "i").test(text))
    .sort((a, b) => b.length - a.length)[0];
  if (!hit) return undefined;

  // Return the clause containing it, so "Head of Operations" survives intact
  // rather than being reported as bare "head of".
  const m = new RegExp(`([A-Za-z&/,'\- ]{0,40}\b${hit.replace(/[-]/g, "[- ]")}\b[A-Za-z&/,'\- ]{0,30})`, "i").exec(text);
  const clause = (m?.[1] ?? hit).trim().replace(/\s+/g, " ");
  return clause.length > 60 ? hit : clause;
}

/**
 * Singapore UEN. Businesses publish it on contact and footer pages far more
 * often than they publish a staff directory, and it is the one identifier that
 * resolves a company unambiguously — worth more than a guessed contact name.
 */
function findUen(text: string): string | undefined {
  const m = /\b(?:UEN|Co(?:mpany)?\.?\s*Reg(?:istration)?\.?(?:\s*No\.?)?)\s*[:.\-]?\s*((?:19|20)\d{7}[A-Z]|\d{8}[A-Z]|[STF]\d{2}[A-Z]{2}\d{4}[A-Z])\b/i.exec(text);
  return m?.[1]?.toUpperCase();
}

function findLegalName(text: string): string | undefined {
  // Anchor on the legal suffix and walk BACKWARDS a few words. A forward regex
  // greedily swallows the whole Title-Case navigation run ("Contact Us Select
  // Page GreenCool ...") because menus are title-cased too.
  const suffix = /\b(Pte\.?\s*Ltd\.?|Private\s+Limited|Pte\.?\s*Limited|LLP)\b/gi;
  const NOISE = new Set([
    "contact", "about", "home", "page", "select", "us", "menu", "the", "our",
    "welcome", "to", "by", "and", "call", "email", "copyright", "©",
  ]);

  // The first "Pte Ltd" on a page is often in a menu or footer with no company
  // name in front of it. Try every occurrence and take the first that yields one.
  for (const m of text.matchAll(suffix)) {
    if (m.index === undefined) continue;
    const before = text.slice(0, m.index).trimEnd().split(/\s+/);
    const parts: string[] = [];
    for (let i = before.length - 1; i >= 0 && parts.length < 4; i--) {
      const w = before[i];
      if (!/^[A-Z][A-Za-z0-9&.,'’-]*$/.test(w)) break;
      if (NOISE.has(w.toLowerCase())) break;
      parts.unshift(w);
    }
    if (!parts.length) continue;
    const name = `${parts.join(" ")} ${m[1]}`.replace(/\s+/g, " ").trim();
    if (name.length <= 70) return name;
  }
  return undefined;
}

export function extractFromHtml(html: string, pageUrl: string): PageExtract {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  // cheerio's .text() concatenates adjacent nodes with no separator, which is
  // how "hello@prisma.io" + "make" became one token. Force a break.
  $("br, p, div, li, td, th, tr, h1, h2, h3, h4, h5, h6, span, a, section, article, footer, header").after(" ");

  const origin = (() => {
    try { return new URL(pageUrl).origin; } catch { return ""; }
  })();

  // ---- emails: mailto links first (highest confidence), then body text ----
  const emails = new Map<string, { value: string; sourceUrl: string; isRoleBased: boolean }>();
  $('a[href^="mailto:"]').each((_, el) => {
    const e = cleanEmail($(el).attr("href") ?? "");
    if (e) emails.set(e, { value: e, sourceUrl: pageUrl, isRoleBased: isRoleBased(e) });
  });

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  for (const m of bodyText.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) {
    const e = cleanEmail(m[0]);
    if (e && !emails.has(e)) emails.set(e, { value: e, sourceUrl: pageUrl, isRoleBased: isRoleBased(e) });
  }

  // ---- phones ----
  const phones = new Map<string, { value: string; sourceUrl: string }>();
  $('a[href^="tel:"]').each((_, el) => {
    const p = cleanPhone($(el).attr("href")?.replace("tel:", "") ?? "");
    if (p) phones.set(p, { value: p, sourceUrl: pageUrl });
  });
  for (const m of bodyText.matchAll(/(?:\+?65[\s-]?)?[3689]\d{3}[\s-]?\d{4}|\+\d{1,3}[\s-]?\d[\d\s-]{7,13}/g)) {
    const p = cleanPhone(m[0]);
    if (p && !phones.has(p)) phones.set(p, { value: p, sourceUrl: pageUrl });
  }

  // ---- people: look for name + title in the same small block ----
  const people: ExtractedContact[] = [];
  const seenNames = new Set<string>();
  const blocks = $("[class*=team] , [class*=member] , [class*=staff] , [class*=person] , [class*=bio] , [class*=leader] , article, li, .card, .col, div");

  blocks.slice(0, 400).each((_, el) => {
    const $el = $(el);
    if ($el.find("*").length > 40) return; // too coarse a container
    const text = $el.text().replace(/\s+/g, " ").trim();
    if (text.length > 320) return;

    const heading = $el.find("h1,h2,h3,h4,h5,strong,b").first().text().trim();
    const candidate = looksLikeName(heading) ? heading : undefined;
    if (!candidate || seenNames.has(candidate)) return;

    // The title must sit near the name, not merely somewhere in the block.
    const nameIdx = text.indexOf(candidate);
    const window = text.slice(Math.max(0, nameIdx - 60), nameIdx + candidate.length + 90);
    const title = findTitleNear(window);
    if (!title) return;

    const email = cleanEmail($el.find('a[href^="mailto:"]').first().attr("href") ?? "") ?? undefined;
    const phone = cleanPhone($el.find('a[href^="tel:"]').first().attr("href")?.replace("tel:", "") ?? "") ?? undefined;

    seenNames.add(candidate);
    people.push({
      fullName: candidate,
      jobTitle: title,
      email,
      phone,
      sourceUrl: pageUrl,
      // A named person with their own address is worth far more than a name alone.
      confidence: email ? 0.9 : phone ? 0.7 : 0.55,
    });
  });

  // ---- addresses (Singapore postal codes are a reliable anchor) ----
  // The postal code is a reliable anchor, but the 120 characters before it are
  // usually page furniture. Trim back to where the address plausibly starts:
  // a block number, a unit number, or a street number.
  const ADDRESS_START = /(?:\bBlk\b|\bBlock\b|\bNo\.?\s*\d|#\d|\b\d{1,4}\s+[A-Z])/;
  const addresses = [...new Set(
    [...bodyText.matchAll(/[^.]{10,140}Singapore\s*\(?\d{6}\)?/gi)].map((m) => {
      const raw = m[0].trim().replace(/\s+/g, " ");
      // Prefer a street-level marker over a unit number, so we keep
      // "Blk 3025 Ubi Road 3 #03-121" rather than just "#03-121".
      const street = raw.search(/(?:\bBlk\b|\bBlock\b|\bNo\.?\s*\d|\b\d{1,4}\s+[A-Z][a-z])/);
      const idx = street >= 0 ? street : raw.search(ADDRESS_START);
      const trimmed = idx > 0 ? raw.slice(idx) : raw;
      return trimmed.length > 140 ? trimmed.slice(-140) : trimmed;
    }),
  )].slice(0, 3);

  // ---- links ----
  const socialLinks = new Set<string>();
  const internalLinks = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    try {
      const u = new URL(href, pageUrl);
      if (/linkedin|facebook|instagram|twitter|x\.com|youtube/.test(u.hostname)) socialLinks.add(u.toString());
      else if (u.origin === origin && !u.pathname.match(/\.(pdf|jpg|png|zip|docx?)$/i)) internalLinks.add(u.origin + u.pathname);
    } catch { /* skip malformed */ }
  });

  return {
    url: pageUrl,
    uen: findUen(bodyText),
    legalName: findLegalName(bodyText),
    likelyJsRendered: html.length > 20000 && bodyText.length < 800,
    title: $("title").first().text().trim() || undefined,
    description: $('meta[name="description"]').attr("content")?.trim(),
    emails: [...emails.values()],
    phones: [...phones.values()],
    people,
    addresses,
    socialLinks: [...socialLinks].slice(0, 8),
    internalLinks: [...internalLinks].slice(0, 60),
    text: bodyText.slice(0, 6000),
  };
}
