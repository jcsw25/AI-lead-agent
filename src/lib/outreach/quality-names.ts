import type { Violation } from "./quality";

/**
 * Fabrication checks: names in the copy that do not exist in the data.
 *
 * Caught in testing: a supplier stored as "Company A (BBQ catering) — RENAME
 * BEFORE SENDING" was written into two buyer emails as "Smokehouse Social". The
 * model saw an obvious placeholder and filled in something plausible. Both
 * drafts read perfectly and passed every tone check — because tone checks ask
 * how copy sounds, not whether what it says is true.
 *
 * That is the most dangerous output this system can produce: a fluent,
 * confident introduction to a company that does not exist, sent under the
 * user's own name. Worth being aggressive about, and worth accepting some false
 * positives to catch — a flagged draft costs a glance, a fabricated one costs a
 * relationship.
 */

/**
 * Capitalised words that are not companies: sentence openers, places, dates,
 * and vocabulary that legitimately appears mid-sentence.
 */
const NOT_A_COMPANY = new Set(
  (
    "I We They You It He She The This That These Those A An And But So If When While Most Some Many " +
    "Their Your My Our His Her Its No Not Nothing Happy Best Regards Hi Hello Hey Dear Thanks Thank " +
    "Singapore Singaporean Malaysia Asia Google Gmail SGD USD MYR " +
    "January February March April May June July August September October November December " +
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday " +
    "Mid-Autumn Chinese New Year Christmas Deepavali Hari Raya Autumn Festival " +
    "Pte Ltd LLP Limited Inc Co Group Holdings Sdn Bhd " +
    "For From With About After Before Anyway However Also Just Here There One Two Three " +
    "BBQ HR IT B2B"
  )
    .split(/\s+/)
    .map((w) => w.toLowerCase()),
);

export const normaliseName = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(pte|ltd|llp|limited|inc|co|company|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

/**
 * Proper-noun phrases in the body that could be a company name.
 *
 * Scans for capitalised sequences rather than a fixed set of introducing
 * phrases. A first attempt matched only "I work with X" and missed the real
 * failure — "I work with a private BBQ caterer, Smokehouse Social" — because
 * the invented name sat in apposition rather than straight after the verb.
 */
export function properNounPhrases(body: string): string[] {
  // Drop greeting and signature lines: those are names by design.
  const core = body
    .split(/\n/)
    .filter((l) => !/^\s*(hi|hey|hello|dear|best|regards|thanks|cheers)\b/i.test(l))
    .join("\n");

  const out = new Set<string>();
  // Two or more capitalised words in a row.
  const re = /\b([A-Z][a-zA-Z][\w&'-]*(?:\s+(?:of\s+|and\s+|&\s+)?[A-Z][\w&'-]*){1,3})/g;

  for (const m of core.matchAll(re)) {
    const phrase = m[1].trim().replace(/[.,;:]+$/, "");
    const words = phrase.split(/\s+/);
    // All-ordinary vocabulary means it is a sentence fragment, not a name.
    if (words.every((w) => NOT_A_COMPANY.has(w.toLowerCase().replace(/[.,;:]+$/, "")))) continue;
    // A phrase starting a sentence is usually just a capitalised first word.
    if (words.length < 2) continue;
    out.add(phrase);
  }
  return [...out];
}

/**
 * @param allowedNames every company this email may legitimately name — the
 * supplier, the recipient, and the sender's own business.
 */
export function checkInventedNames(body: string, allowedNames: string[]): Violation[] {
  const allowed = allowedNames.filter(Boolean).map(normaliseName).filter((x) => x.length > 2);
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const phrase of properNounPhrases(body)) {
    const n = normaliseName(phrase);
    if (n.length < 5 || seen.has(n)) continue;
    // Fine if it matches, contains, or is contained by a name we hold — "Met"
    // inside "Met Pte Ltd" is the same company.
    if (allowed.some((a) => a === n || a.includes(n) || n.includes(a))) continue;
    seen.add(n);
    violations.push({
      rule: "invented company name",
      detail:
        `"${phrase}" is named in the copy but is not a company in the database. ` +
        `Only these may be named: ${allowedNames.filter(Boolean).join(", ") || "(none)"}.`,
    });
  }
  return violations;
}

/** A placeholder that must never reach a recipient. */
export function checkPlaceholders(body: string, subject: string): Violation[] {
  const blob = `${subject}\n${body}`;
  const tells = [
    /\bRENAME BEFORE SENDING\b/i,
    /\bCompany [AB]\b/,
    /\[(?:name|company|insert|placeholder|your \w+)\]/i,
    /\bXXX+\b/,
    /\bTBD\b/,
    /\bexample\.(?:com|org|test)\b/i,
    /\blorem ipsum\b/i,
  ];
  for (const re of tells) {
    const m = blob.match(re);
    if (m) {
      return [
        {
          rule: "placeholder in copy",
          detail: `"${m[0]}" is a placeholder, not something a recipient should read.`,
        },
      ];
    }
  }
  return [];
}
