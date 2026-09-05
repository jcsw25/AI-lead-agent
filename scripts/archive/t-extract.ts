import { extractFromHtml } from "@/scraper/extract";
import { db } from "@/lib/db";

// Do the repaired regexes actually work now?
const html = `<html><body>
  <p>ACME Aircon Engineering Pte Ltd</p>
  <p>UEN: 201812345A</p>
  <p>Blk 140 Owen Road, Singapore 218940</p>
  <a href="mailto:hello@acme.com.sg">hello@acme.com.sg</a>
</body></html>`;
const e = extractFromHtml(html, "https://acme.com.sg");
console.log(`UEN extracted      ${e.uen ?? "(none)"}`);
console.log(`legal name         ${e.legalName ?? "(none)"}`);
console.log(`addresses          ${JSON.stringify(e.addresses)}`);

console.log(`\nwhat the broken version cost, across the live database:`);
console.log(`  companies with a UEN on file     ${await db.companyIdentifier.count({ where: { scheme: "UEN" } })}`);
const addrs = await db.company.findMany({ where: { addressLine: { not: null } }, select: { addressLine: true } });
const polluted = addrs.filter((a) => /HOME|COMPANY PROFILE|SERVICES|CONTACT US|MENU/i.test(a.addressLine ?? ""));
console.log(`  addresses stored                 ${addrs.length}`);
console.log(`  ...polluted with nav-menu text   ${polluted.length}`);
for (const p of polluted.slice(0, 3)) console.log(`     ${p.addressLine?.slice(0, 90)}`);
await db.$disconnect();
