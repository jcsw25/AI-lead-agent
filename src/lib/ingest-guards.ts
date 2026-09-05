/**
 * What must never enter the company table, checked at the door.
 *
 * These guards exist because every one of them was found in the live database
 * during an audit, and because the previous attempts to fix the same problems
 * were made at the point of USE rather than at ingest. Patching the email
 * writer so it falls back to the domain when a name is junk made the emails
 * better and left 1,193 rows wrong — so the calls page, the sheet and the
 * acquisition list each had to rediscover the same problem and patch it again.
 *
 * A guard here is worth three patches downstream, and it is the only place that
 * stops the count growing.
 */

/**
 * Domains that are never a lead.
 *
 * All of these were actually in the database. The Singapore Dental Council
 * reached QUALIFIED status and sat in four introductions; a comment in
 * entity.ts records that happening once before, which means the filter written
 * to catch it did not.
 */
const NEVER_A_LEAD: Array<[RegExp, string]> = [
  [/(^|\.)gov(\.[a-z]{2})?$|\.gov\./i, "a government body — a regulator is not a lead"],
  [/(^|\.)edu(\.[a-z]{2})?$|\.edu\./i, "an educational institution"],
  [/(^|\.)mil(\.|$)/i, "a military domain"],
  [/wikipedia|wikiwand|fandom\.com|britannica|encyclopedia/i, "an encyclopaedia"],
  [/(^|\.)(cambridge|oxfordlearners|merriam-webster|dictionary|thefreedictionary)\./i, "a dictionary"],
  [/hellotoby|thumbtack|bark\.com|serviceseeking|airtasker/i, "a services marketplace"],
  [/(^|\.)(facebook|instagram|linkedin|twitter|x)\.com$/i, "a social platform"],
  [/(^|\.)(wordpress|blogspot|wix|squarespace|weebly|godaddysites)\.com$/i, "a website builder's own domain"],
  [/(^|\.)(indeed|glassdoor|jobstreet|mycareersfuture)\./i, "a job board"],
  [/(^|\.)(carousell|shopee|lazada|qoo10|taobao|alibaba|aliexpress)\./i, "a marketplace"],
  [/yellowpages|yelp\.|tripadvisor|foursquare|coursetakers|wanderlog/i, "a directory"],
  [/(^|\.)(reddit|quora|medium|substack|pinterest|youtube|tiktok)\./i, "a content platform"],
  [/(^|\.)(google|bing|yahoo|duckduckgo)\./i, "a search engine"],
];

/** Domains whose shape says "list of businesses" rather than "a business". */
const DIRECTORY_SHAPE =
  /(^|[.-])(directory|listings?|reviews?|compare|finder|ratings?|top\d+|best[a-z]*(sg|singapore))([.-]|$)/i;

/**
 * Is this domain a company we could sell to, or something else?
 *
 * Returns the reason it is not, or false when it is fine — the same shape as
 * the existing isNonBusiness(), so the two read alike at call sites.
 */
export function isNotACompany(domain: string | null | undefined): false | string {
  if (!domain) return false;
  const d = domain.toLowerCase().replace(/^www\./, "");

  for (const [re, why] of NEVER_A_LEAD) {
    if (re.test(d)) return why;
  }
  if (DIRECTORY_SHAPE.test(d)) return "a directory rather than a business";
  return false;
}

/**
 * Countries other than the one we operate in, spotted from the domain.
 *
 * elegislation.gov.hk was in the database, classified as an HVAC company. The
 * .gov guard catches that one, but a Malaysian or Indonesian company site would
 * pass every other check while being unreachable by a Singapore sales call.
 */
const FOREIGN_TLD = /\.(my|id|th|vn|ph|hk|cn|tw|in|au|nz|uk|us|ca)$/i;

export function looksForeign(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  if (/\.(sg|com\.sg|net\.sg|org\.sg|edu\.sg|gov\.sg)$/i.test(d)) return false;
  return FOREIGN_TLD.test(d);
}

/**
 * A phone number that could actually be dialled in Singapore, or null.
 *
 * Singapore numbers are eight digits beginning 6, 8 or 9, optionally with the
 * +65 country code. 150 of 1,334 stored numbers fail that, and the repeats give
 * the reason away: 2062218284 appears against three different companies and
 * 208809207625 against two, so they are tracking numbers or a web agency's own
 * line lifted off a shared template.
 *
 * A number that cannot be dialled costs a slot in the call queue and a minute
 * of somebody's time before they find out.
 */
export function normaliseSgPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^0-9]/g, "");
  if (d.startsWith("0065")) d = d.slice(4);
  else if (d.startsWith("65") && d.length === 10) d = d.slice(2);
  if (!/^[689]\d{7}$/.test(d)) return null;
  return `+65 ${d.slice(0, 4)} ${d.slice(4)}`;
}

/**
 * A tidy industry label.
 *
 * "tertiary eduCATION" is a real stored value covering 60 companies. Industry
 * is the field almost every query in the system filters on — the call queue,
 * the batch drafter, the pairing seeder — so a mangled label silently removes
 * those companies from all of them.
 */
export function normaliseIndustry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Lowercase anything SHOUTED or MiXeD, but leave real acronyms (HVAC, F&B)
  // and properly-cased names alone.
  const mangled = /[a-z][A-Z]{2,}|^[A-Z\s&]{6,}$/.test(s);
  return (mangled ? s.toLowerCase() : s).slice(0, 80);
}
