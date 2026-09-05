/**
 * Repair listings collected before the figures were properly gated.
 *
 *   npx tsx scripts/fix-listing-figures.ts --dry-run
 *   npx tsx scripts/fix-listing-figures.ts
 *
 * Three faults, all found by reading the collected data rather than by testing
 * the code:
 *
 *   1. Multiples were computed across whatever profit term each listing used.
 *      A preschool quoting a MONTHLY profit of 20,000 against a 520,000 asking
 *      price was recorded at 26x, where the real annual figure is about 2.2.
 *   2. A shop lease was collected as a business with an asking price of SGD 100,
 *      which was a rent.
 *   3. Every listing from one marketplace carried the identical reason for
 *      selling — site boilerplate, not twenty-two owners emigrating.
 *
 * Nothing is re-fetched and no model is called. The profit term each listing
 * used was already written into the notes verbatim, so it is recovered from
 * there — the repaired data is exactly what was extracted, only correctly
 * gated.
 */
import { db } from "@/lib/db";
import { askingMultiple, isPropertyNotBusiness } from "@/agents/listing-extractor";

const dryRun = process.argv.includes("--dry-run");
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

const all = await db.acquisitionTarget.findMany({
  where: { businessId: biz.id, origin: "LISTED" },
});

// The extractor's own words, written at collection time:
//   Profit is stated as "Monthly profit", not EBITDA — ...
const TERM_IN_NOTE = /Profit is stated as "([^"]+)"/;

let termsRecovered = 0;
let multiplesCleared = 0;
let property = 0;

// A reason repeated across a source is that source's placeholder text.
const reasonCounts = new Map<string, number>();
for (const t of all) {
  if (!t.sellerReason) continue;
  const k = `${t.listingSource}::${t.sellerReason}`;
  reasonCounts.set(k, (reasonCounts.get(k) ?? 0) + 1);
}
const boilerplate = new Set([...reasonCounts].filter(([, n]) => n >= 4).map(([k]) => k));

console.log(`${all.length} listed targets\n`);
if (boilerplate.size) {
  console.log(`boilerplate reasons for selling:`);
  for (const k of boilerplate) {
    const [src, reason] = k.split("::");
    console.log(`  ${reasonCounts.get(k)}x on ${src}: "${reason}"`);
  }
  console.log();
}

for (const t of all) {
  // A profit figure with no term in the notes was EBITDA — the note is only
  // written when the term differs.
  const term = t.notes?.match(TERM_IN_NOTE)?.[1] ?? (t.ebitda != null ? "EBITDA" : null);
  if (term) termsRecovered++;

  const correctedMultiple = askingMultiple(
    t.askingPrice == null ? null : Number(t.askingPrice),
    t.ebitda == null ? null : Number(t.ebitda),
    term,
  );
  if (t.askingMultiple != null && correctedMultiple == null) {
    multiplesCleared++;
    console.log(
      `  clear ${String(t.askingMultiple).padStart(5)}x  ${t.name.slice(0, 48).padEnd(50)} profit was "${term}"`,
    );
  }

  const isProperty = isPropertyNotBusiness(t.name);
  if (isProperty) {
    property++;
    console.log(`  drop  premises to rent, not a business: ${t.name.slice(0, 60)}`);
  }

  const key = `${t.listingSource}::${t.sellerReason}`;
  const isBoiler = Boolean(t.sellerReason) && boilerplate.has(key);

  if (dryRun) continue;

  if (isProperty) {
    await db.acquisitionTarget.delete({ where: { id: t.id } });
    continue;
  }
  await db.acquisitionTarget.update({
    where: { id: t.id },
    data: {
      profitTerm: term,
      askingMultiple: correctedMultiple,
      sellerReason: isBoiler ? null : t.sellerReason,
      notes: isBoiler
        ? `${t.notes ?? ""} The listing's stated reason for selling ("${t.sellerReason}") is the same on every listing from ${t.listingSource}, so it is site boilerplate rather than this owner's reason.`.trim()
        : t.notes,
    },
  });
}

const boilerRows = [...boilerplate].reduce((a, k) => a + (reasonCounts.get(k) ?? 0), 0);
console.log(`\nprofit terms recovered   ${termsRecovered}`);
console.log(`multiples cleared        ${multiplesCleared}  (computed across incompatible terms)`);
console.log(`property listings ${dryRun ? "to drop" : "dropped"}  ${property}`);
console.log(`boilerplate reasons ${dryRun ? "to clear" : "cleared"}  ${boilerRows}`);
if (dryRun) console.log(`\ndry run — nothing was written`);

await db.$disconnect();
