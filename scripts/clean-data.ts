/**
 * Repair the data problems the audit found, across everything already stored.
 *
 *   npx tsx scripts/clean-data.ts --dry-run
 *   npx tsx scripts/clean-data.ts
 *
 * The guards in src/lib/ingest-guards.ts stop these arriving from now on. This
 * fixes what is already here:
 *
 *   1. 51 records that are not companies — government agencies, wikis,
 *      website builders, job boards, directories. The Singapore Dental Council
 *      among them, which a code comment says was caught once before.
 *   2. 166 companies named after a page heading rather than a business.
 *      NOT duplicates: eleven different firms share "Aircon Servicing
 *      Singapore", so they are renamed from their domain, never merged.
 *   3. 150 phone numbers that cannot be Singapore numbers.
 *   4. Mangled industry labels — "tertiary eduCATION" covers 60 companies.
 *
 * Deleting a company cascades to its contacts, claims, audit and prospects, so
 * the dry run prints exactly what would go before anything does.
 */
import { db } from "@/lib/db";
import { displayCompanyName } from "@/lib/entity";
import { isNotACompany, looksForeign, normaliseIndustry, normaliseSgPhone } from "@/lib/ingest-guards";

const dryRun = process.argv.includes("--dry-run");
const say = (s: string) => console.log(s);

// ---- 1. records that are not companies --------------------------------------
const companies = await db.company.findMany({
  select: { id: true, name: true, primaryDomain: true, industry: true },
});

const notCompanies = companies
  .map((c) => ({ c, why: isNotACompany(c.primaryDomain) || (looksForeign(c.primaryDomain) ? "operates outside Singapore" : false) }))
  .filter((x): x is { c: (typeof companies)[number]; why: string } => Boolean(x.why));

say(`--- not companies: ${notCompanies.length} ---`);
for (const { c, why } of notCompanies.slice(0, 12)) {
  say(`  ${(c.primaryDomain ?? "?").padEnd(30)} "${c.name.slice(0, 30)}"  — ${why}`);
}
if (notCompanies.length > 12) say(`  … and ${notCompanies.length - 12} more`);

if (!dryRun) {
  for (const { c } of notCompanies) {
    // Messages reference contacts, which cascade from the company. Anything
    // already sent to one of these is history worth keeping, so a company with
    // a sent message is kept and flagged instead of deleted.
    const sent = await db.message.count({
      where: { contact: { companyId: c.id }, status: "SENT" },
    });
    if (sent > 0) {
      await db.prospect.updateMany({
        where: { companyId: c.id },
        data: { stage: "DISQUALIFIED", disqualifiedReason: "Not a company — kept because mail was already sent." },
      });
      continue;
    }
    await db.company.delete({ where: { id: c.id } });
  }
}

// ---- 2. names that are page headings ----------------------------------------
const renames: Array<{ id: string; from: string; to: string }> = [];
for (const c of companies) {
  if (notCompanies.some((n) => n.c.id === c.id)) continue;
  const better = displayCompanyName(c.name, c.primaryDomain, c.industry ?? undefined);
  if (better && better !== c.name) renames.push({ id: c.id, from: c.name, to: better });
}
say(`\n--- names that are page headings: ${renames.length} ---`);
for (const r of renames.slice(0, 10)) say(`  "${r.from.slice(0, 38).padEnd(40)}" -> "${r.to}"`);
if (renames.length > 10) say(`  … and ${renames.length - 10} more`);
if (!dryRun) {
  for (const r of renames) await db.company.update({ where: { id: r.id }, data: { name: r.to } });
}

// ---- 3. phone numbers that cannot be dialled --------------------------------
const contacts = await db.contact.findMany({ where: { phone: { not: null } }, select: { id: true, phone: true } });
const badPhones = contacts.filter((c) => !normaliseSgPhone(c.phone));
const reformat = contacts
  .map((c) => ({ id: c.id, from: c.phone!, to: normaliseSgPhone(c.phone) }))
  .filter((x) => x.to && x.to !== x.from);

say(`\n--- phone numbers ---`);
say(`  cannot be Singapore numbers, will be cleared : ${badPhones.length}`);
say(`    e.g. ${badPhones.slice(0, 6).map((c) => c.phone).join(", ")}`);
say(`  valid, reformatted to a consistent shape     : ${reformat.length}`);
if (!dryRun) {
  for (const c of badPhones) await db.contact.update({ where: { id: c.id }, data: { phone: null } });
  for (const r of reformat) await db.contact.update({ where: { id: r.id }, data: { phone: r.to } });
}

// ---- 4. industry labels ------------------------------------------------------
const industries = [...new Set(companies.map((c) => c.industry).filter(Boolean) as string[])];
const fixes = industries
  .map((i) => ({ from: i, to: normaliseIndustry(i) }))
  .filter((x) => x.to && x.to !== x.from);
say(`\n--- industry labels: ${fixes.length} need normalising ---`);
for (const f of fixes) say(`  "${f.from}" -> "${f.to}"`);
if (!dryRun) {
  for (const f of fixes) {
    await db.company.updateMany({ where: { industry: f.from }, data: { industry: f.to } });
  }
}

// ---- summary -----------------------------------------------------------------
say(`\n${"=".repeat(58)}`);
say(`  ${dryRun ? "would delete" : "deleted"}    ${notCompanies.length} non-companies`);
say(`  ${dryRun ? "would rename" : "renamed"}    ${renames.length} companies`);
say(`  ${dryRun ? "would clear" : "cleared"}     ${badPhones.length} undialable phone numbers`);
say(`  ${dryRun ? "would tidy" : "tidied"}      ${reformat.length} phone formats, ${fixes.length} industry labels`);
if (dryRun) say(`\n  dry run — nothing was written`);
else say(`\n  companies remaining: ${await db.company.count()}`);
await db.$disconnect();
