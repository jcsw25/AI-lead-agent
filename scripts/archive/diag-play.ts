import { db } from "@/lib/db";

/**
 * How big is the "no enquiry form" play?
 *
 * A weakness only matters if the company is also reachable — a broken site we
 * cannot email about is not an opportunity, it is a statistic.
 */
const companies = await db.company.findMany({
  where: { siteAudit: { reachable: true, hasContactForm: false } },
  select: {
    name: true, primaryDomain: true, industry: true,
    contacts: { select: { email: true, phone: true } },
    siteAudit: { select: { score: true, findings: true, copyrightYear: true } },
  },
});

const reachable = companies.filter((c) => c.contacts.some((x) => x.email || x.phone));
const withEmail = companies.filter((c) => c.contacts.some((x) => x.email));

console.log(`no enquiry form                 ${companies.length}`);
console.log(`  ...and we can contact them    ${reachable.length}`);
console.log(`  ...by email specifically      ${withEmail.length}`);

const byIndustry = new Map<string, number>();
for (const c of reachable) byIndustry.set(c.industry ?? "?", (byIndustry.get(c.industry ?? "?") ?? 0) + 1);
console.log(`\nby industry:`);
for (const [k, v] of [...byIndustry.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}

console.log(`\nten you could email today:`);
for (const c of withEmail.slice(0, 10)) {
  const e = c.contacts.find((x) => x.email)?.email;
  console.log(`  ${c.name.slice(0, 30).padEnd(32)} ${(c.primaryDomain ?? "").padEnd(28)} ${e}`);
}

await db.$disconnect();
