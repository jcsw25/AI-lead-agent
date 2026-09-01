import { db } from "@/lib/db";
const NAV = /HOME|COMPANY PROFILE|SERVICES|CONTACT US|MENU|MAJOR CLIENTS|Send us your feedback/i;
const rows = await db.company.findMany({ where: { addressLine: { not: null } }, select: { id: true, name: true, addressLine: true } });
const bad = rows.filter((r) => NAV.test(r.addressLine ?? ""));
console.log(`clearing ${bad.length} polluted addresses so the re-crawl replaces them rather than falling back:`);
for (const b of bad) console.log(`  ${b.name.slice(0, 30).padEnd(32)} ${b.addressLine?.slice(0, 60)}`);
await db.company.updateMany({ where: { id: { in: bad.map((b) => b.id) } }, data: { addressLine: null } });
// Claims carry the same pollution.
const claims = await db.claim.findMany({ where: { field: "company.address" }, select: { id: true, value: true } });
const badClaims = claims.filter((c) => NAV.test(String(c.value)));
await db.claim.deleteMany({ where: { id: { in: badClaims.map((c) => c.id) } } });
console.log(`\nalso removed ${badClaims.length} polluted address claims`);
await db.$disconnect();
