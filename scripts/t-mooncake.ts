import { db } from "@/lib/db";
const cs = await db.company.findMany({
  where: { industry: "mooncake" },
  select: { name: true, primaryDomain: true, contacts: { select: { email: true } }, siteAudit: { select: { reachable: true } } },
});
const MEDIA = /(channelnewsasia|mothership|asiaone|tatlerasia|michelin|straitstimes|theindependent|blogspot|wordpress|medium|lemon8|tiktok|amazon|myshopify|shopify|amway|klt\.com|omnivorescookbook|bellyrumbles|augustman|districtsixtyfive|janicewong|changiairport|appspos|season\.com)/i;
const media = cs.filter((c) => MEDIA.test(c.primaryDomain ?? ""));
console.log(`mooncake companies saved   ${cs.length}`);
console.log(`  sites crawled            ${cs.filter((c) => c.siteAudit).length}`);
console.log(`  with an email            ${cs.filter((c) => c.contacts.some((x) => x.email)).length}`);
console.log(`  MEDIA / PLATFORM, not a business: ${media.length}`);
for (const m of media.slice(0, 12)) console.log(`     ${(m.primaryDomain ?? "").padEnd(28)} ${m.name.slice(0, 40)}`);
const run = await db.scrapeRun.findFirst({ where: { mode: "enrich", query: { contains: "mooncake" } }, orderBy: { startedAt: "desc" } });
console.log(`\nenrich run: ${run?.status}  ${JSON.stringify(run?.log)?.slice(0, 90)}`);
await db.$disconnect();
