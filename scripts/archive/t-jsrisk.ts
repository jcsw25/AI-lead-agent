import { db } from "@/lib/db";
// Sites whose audit says "no form" AND "no email link" AND "no structured data"
// are the shape a client-rendered page produces when read as raw HTML.
const audits = await db.siteAudit.findMany({
  where: { reachable: true },
  include: { company: { select: { name: true, primaryDomain: true, description: true } } },
});
const n = audits.length;
const noForm = audits.filter((a) => !a.hasContactForm);
const suspicious = audits.filter((a) => !a.hasContactForm && !a.hasEmailLink && !a.hasPhoneLink && !a.hasStructured);
const flaggedJs = audits.filter((a) => a.jsRendered);
const noDesc = audits.filter((a) => !a.company.description);

console.log(`audited sites                       ${n}`);
console.log(`  audit says "no enquiry form"      ${noForm.length}  (${Math.round(noForm.length/n*100)}%)`);
console.log(`  flagged as JS-rendered            ${flaggedJs.length}  (${Math.round(flaggedJs.length/n*100)}%)`);
console.log(`\nlooks like a client-rendered page read as raw HTML`);
console.log(`  (no form + no links + no structured data)`);
console.log(`  ${suspicious.length} sites  — ${Math.round(suspicious.length/noForm.length*100)}% of every "no form" claim`);
console.log(`\nno description extracted at all      ${noDesc.length}  (another JS tell)`);
console.log(`\nexamples of the suspicious set:`);
for (const a of suspicious.slice(0, 8)) console.log(`   ${(a.company.primaryDomain ?? "").padEnd(30)} score ${a.score}`);
await db.$disconnect();
