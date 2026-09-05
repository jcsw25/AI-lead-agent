import { db } from "@/lib/db";

/**
 * Matching what a buyer called something to what we already call it.
 *
 * A need raised in a reply arrives in the buyer's words — "a good commercial
 * cleaner" — while the categories the rest of the system works in come from
 * pairings: "Commercial cleaning contractors". Stored as written, the two sit
 * as separate rows for the same company, and neither is what a supplier search
 * looks for. The wiring test surfaced exactly that, on a company that already
 * had the cleaning need.
 *
 * So a raised need is matched against the categories in use before it is
 * stored. The bar is deliberately high: a wrong merge files a real stated need
 * under a trade nobody asked about, which is worse than one extra category.
 */

/** Words that appear in half the categories and so distinguish nothing. */
const GENERIC = new Set([
  "and", "or", "of", "the", "a", "for", "with",
  "service", "services", "servicing", "commercial", "industrial", "corporate", "business",
  "contractor", "contractors", "company", "companies", "supplier", "suppliers",
  "provider", "providers", "vendor", "vendors", "specialist", "specialists",
  "solutions", "network", "membership", "organization", "organisation", "firm", "firms",
]);

/**
 * Crude suffix stripping so "cleaner", "cleaning" and "cleans" agree.
 * Not linguistics — just enough that a plural or a gerund is not a new trade.
 */
function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const suffix of ["ings", "ing", "ers", "er", "ies", "ion", "es", "s"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

/** The words in a category that actually identify a trade. */
function distinctive(phrase: string): Set<string> {
  return new Set(
    phrase
      .split(/[\s,/&-]+/)
      .filter(Boolean)
      .filter((w) => !GENERIC.has(w.toLowerCase()))
      .map(stem)
      .filter((w) => w.length > 2),
  );
}

/**
 * How much two category names mean the same thing, 0 to 1.
 *
 * Scored against both names rather than just the shorter one. Measuring only
 * the shorter was tried and is useless here: "commercial cleaner" reduces to
 * the single word "clean", which then scored a perfect 1.00 against
 * "Commercial cleaning contractors", "Facade cleaning and rope access", "Water
 * tank cleaning and testing" and "Grease trap and kitchen exhaust cleaning"
 * alike — four different trades, indistinguishable.
 *
 * Counting both sides is what separates them: the words a category carries that
 * the buyer never said are evidence it is a different trade. Facade work and
 * rope access are not what somebody asking for a cleaner meant.
 */
export function categorySimilarity(a: string, b: string): number {
  const A = distinctive(a);
  const B = distinctive(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/**
 * Return the name we already use for this trade, or the buyer's own words if
 * we have no name for it.
 *
 * Everything they said stays recoverable either way: the verbatim quote is
 * stored on the need, so a merge never loses how they put it.
 */
export async function canonicalCategory(
  businessId: string,
  raw: string,
): Promise<{ category: string; mergedInto?: string; ambiguousWith?: string[] }> {
  const phrase = raw.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!phrase) return { category: phrase };

  const [needCats, pairings] = await Promise.all([
    db.need.groupBy({ by: ["category"], where: { businessId }, _count: { _all: true } }),
    db.pairing.findMany({ where: { businessId }, select: { supplierIndustry: true }, distinct: ["supplierIndustry"] }),
  ]);

  const known = new Set<string>([
    ...needCats.map((c) => c.category),
    ...pairings.map((p) => p.supplierIndustry),
  ]);

  const scored: Array<{ name: string; score: number }> = [];
  for (const k of known) {
    if (k.toLowerCase() === phrase.toLowerCase()) return { category: k };
    scored.push({ name: k, score: categorySimilarity(phrase, k) });
  }
  scored.sort((a, b) => b.score - a.score);

  // 0.6 rather than a majority: counting both sides means an exact trade match
  // buried in a longer official name — "aircon maintenance" against "aircon
  // servicing" — lands around two thirds, and those are the merges worth making.
  const best = scored[0];
  if (!best || best.score < 0.6) return { category: phrase };

  // Two categories fitting equally well is not a close call to break — it means
  // the buyer's words genuinely span both, as "freight forwarding" does across
  // "logistics and freight forwarding" and "Freight forwarder network". Picking
  // one would file a real stated need under a trade chosen by sort order, so
  // neither is picked and their own wording stands.
  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < 0.1) {
    return { category: phrase, ambiguousWith: [best.name, runnerUp.name] };
  }

  return { category: best.name, mergedInto: best.name };
}
