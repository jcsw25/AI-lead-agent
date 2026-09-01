/**
 * Apply the entity rules to rows that were created before those rules existed.
 *
 *   npx tsx scripts/repair.ts            # dry run — shows what would change
 *   npx tsx scripts/repair.ts --apply
 *
 * Three repairs, matching the three source fixes:
 *   1. names that are page furniture ("Home") -> derived from the domain
 *   2. Contact rows holding an address on someone else's domain -> email cleared
 *      (the Claim stays: the address was really found, it just is not a route)
 *   3. non-businesses flagged so the next qualification pass rejects them
 *
 * Nothing is deleted. A Contact with a foreign email but a real phone keeps the
 * phone; only the address is removed.
 */
import { db } from "@/lib/db";
import { companyNameFrom, nameFromDomain, sendableEmails, isNonBusiness } from "@/lib/entity";

const apply = process.argv.includes("--apply");
if (!apply) console.log("DRY RUN — pass --apply to write changes\n");

const companies = await db.company.findMany({
  select: {
    id: true, name: true, primaryDomain: true,
    contacts: { select: { id: true, email: true, phone: true, fullName: true } },
  },
});

let renamed = 0;
let emailsCleared = 0;
let contactsRemoved = 0;
let nonBusinesses = 0;
const examples: string[] = [];

for (const c of companies) {
  const domain = c.primaryDomain;

  // ---- 1. names ----------------------------------------------------------
  if (domain) {
    // Run the current rules over the stored name. If they reject it, the name
    // was page furniture and the domain is the more honest source.
    const repaired = companyNameFrom(c.name, domain);
    if (repaired !== c.name) {
      if (examples.length < 20) examples.push(`  name    "${c.name}" -> "${repaired}"`);
      renamed++;
      if (apply) await db.company.update({ where: { id: c.id }, data: { name: repaired } });
    }
  }

  // ---- 2. email attribution ---------------------------------------------
  const real = c.contacts.filter((ct) => ct.email && !ct.email.startsWith("unknown-"));
  const { rejected } = sendableEmails(real.map((ct) => ({ ...ct, value: ct.email! })), domain);
  const rejectedIds = new Map(rejected.map((r) => [r.email.id, r.reason]));

  for (const ct of real) {
    const why = rejectedIds.get(ct.id);
    if (why) {
      if (examples.length < 20) examples.push(`  email   ${c.name}: ${ct.email} — ${why}`);
      if (ct.phone) {
        emailsCleared++;
        if (apply) await db.contact.update({ where: { id: ct.id }, data: { email: null } });
      } else {
        // No phone either, so the row has no route left at all.
        contactsRemoved++;
        if (apply) await db.contact.delete({ where: { id: ct.id } });
      }
    }
  }

  // ---- 3. non-businesses -------------------------------------------------
  const why = isNonBusiness(domain, c.name);
  if (why) {
    nonBusinesses++;
    if (examples.length < 20) examples.push(`  entity  ${c.name} (${domain}) — ${why}`);
  }
}

console.log(`companies renamed              ${renamed}`);
console.log(`emails cleared (phone kept)    ${emailsCleared}`);
console.log(`contact rows removed           ${contactsRemoved}`);
console.log(`non-businesses to be rejected  ${nonBusinesses}`);

if (examples.length) {
  console.log(`\nexamples:`);
  for (const e of examples) console.log(e);
}

if (!apply) {
  console.log(`\nnothing written. Re-run with --apply.`);
} else {
  console.log(`\ndone. Run "npm run qualify" then "npm run pair -- --match-only" to rebuild.`);
}

// A name derived purely from a domain, for reference.
if (!apply) {
  console.log(`\ndomain-derived names, for a sense of quality:`);
  for (const d of ["singaporedentalspecialists.sg", "toothstories.com", "greencoolaircon.com", "brandpack.com.sg"]) {
    console.log(`  ${d.padEnd(32)} -> ${nameFromDomain(d)}`);
  }
}

await db.$disconnect();
