/**
 * Does a need raised in a buyer's own words land under the right category?
 *
 *   npx tsx scripts/test-category.ts
 *
 * No model calls, so this is free and runs against the live category list —
 * which is the point. The matcher is only correct relative to the categories
 * that actually exist, and those change every time a pairing is added. A case
 * that passes today can start colliding with a new category tomorrow, and this
 * is what says so.
 *
 * Where the expectation is empty, the buyer's own wording is supposed to
 * survive: either nothing close exists, or several things do and picking one
 * would be a coin flip.
 */
import { db } from "@/lib/db";
import { canonicalCategory } from "@/lib/demand/category";

const CASES: Array<[string, string]> = [
  ["commercial cleaner", "Commercial cleaning contractors"],
  ["a good commercial cleaner", "Commercial cleaning contractors"],
  ["office cleaning", "Commercial cleaning contractors"],
  ["laundry service", "Commercial laundry and linen services"],
  ["aircon maintenance", "aircon servicing"],
  ["printing", "commercial printing"],
  ["pest control", "Licensed pest control operators"],
  // Nothing close enough. A new category is the honest outcome.
  ["a payroll system", ""],
  ["security guards", ""],
  ["someone to redo our website", ""],
  // "flowers" and "florist" share no stem. A miss, but the conservative
  // direction: the need is still recorded, just under their wording.
  ["flowers for the lobby", ""],
];

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

let bad = 0;
for (const [raw, want] of CASES) {
  const r = await canonicalCategory(biz.id, raw);
  const kept = r.category.toLowerCase() === raw.toLowerCase();
  const got = kept ? "" : r.category;
  const ok = want ? got === want : kept;
  if (!ok) bad++;
  const note = r.ambiguousWith ? `  [ambiguous: ${r.ambiguousWith.join(" / ")}]` : "";
  console.log(
    `${ok ? "ok  " : "FAIL"}  "${raw}" → ${got || "(their words)"}${note}` +
      (ok ? "" : `   expected ${want || "(their words)"}`),
  );
}

console.log(`\n${CASES.length - bad}/${CASES.length}`);
await db.$disconnect();
process.exit(bad ? 1 : 0);
