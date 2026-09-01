import { db } from "@/lib/db";
const uens = await db.companyIdentifier.count({ where: { scheme: "UEN" } });
const addrs = await db.company.findMany({ where: { addressLine: { not: null } }, select: { name: true, addressLine: true } });
const NAV = /HOME|COMPANY PROFILE|SERVICES|CONTACT US|MENU|MAJOR CLIENTS|Send us your feedback|About Us|Privacy/i;
const bad = addrs.filter((a) => NAV.test(a.addressLine ?? ""));
const legal = await db.company.count({ where: { legalName: { not: null } } });

console.log(`UENs captured            ${uens}   (was 0)`);
console.log(`legal names captured     ${legal}`);
console.log(`addresses stored         ${addrs.length}`);
console.log(`  ...still polluted      ${bad.length}   (was 10)`);
for (const b of bad.slice(0, 4)) console.log(`     ${b.name.slice(0,24).padEnd(26)} ${b.addressLine?.slice(0, 60)}`);

console.log(`\nsample of recovered UENs:`);
const s = await db.companyIdentifier.findMany({ where: { scheme: "UEN" }, take: 6, include: { company: { select: { name: true, legalName: true } } } });
for (const x of s) console.log(`  ${x.value.padEnd(12)} ${(x.company.legalName ?? x.company.name).slice(0, 46)}`);

console.log(`\nsample of clean addresses:`);
for (const a of addrs.filter((x) => !NAV.test(x.addressLine ?? "")).slice(0, 4)) {
  console.log(`  ${a.name.slice(0,24).padEnd(26)} ${a.addressLine?.slice(0, 56)}`);
}
await db.$disconnect();
