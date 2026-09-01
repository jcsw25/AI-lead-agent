import { db } from "@/lib/db";
const cs = await db.company.findMany({
  where: { industry: { in: ["aircon servicing", "HVAC"], mode: "insensitive" } },
  select: {
    name: true, primaryDomain: true, description: true,
    contacts: { select: { email: true, phone: true } },
    siteAudit: true,
    qualifications: { select: { status: true } },
  },
});
const live = cs.filter((c) => c.qualifications[0]?.status !== "REJECTED");
const audited = live.filter((c) => c.siteAudit?.reachable);
const n = audited.length;
const pct = (k: number) => `${Math.round((k / n) * 100)}%`;
const count = (f: (a: NonNullable<(typeof audited)[number]["siteAudit"]>) => boolean) =>
  audited.filter((c) => c.siteAudit && f(c.siteAudit)).length;

console.log(`aircon + HVAC companies in the database  ${cs.length}`);
console.log(`  not rejected                           ${live.length}`);
console.log(`  websites actually opened               ${n}`);
console.log(`  with an email                          ${live.filter((c) => c.contacts.some((x) => x.email)).length}`);
console.log(`  with a phone                           ${live.filter((c) => c.contacts.some((x) => x.phone)).length}`);

console.log(`\nWhat their websites measurably lack (of ${n} audited):`);
console.log(`  no enquiry form                        ${count((a) => !a.hasContactForm)}  ${pct(count((a) => !a.hasContactForm))}`);
console.log(`  no clickable email or phone link       ${count((a) => !a.hasEmailLink && !a.hasPhoneLink)}  ${pct(count((a) => !a.hasEmailLink && !a.hasPhoneLink))}`);
console.log(`  no structured data (invisible to search) ${count((a) => !a.hasStructured)}  ${pct(count((a) => !a.hasStructured))}`);
console.log(`  no social profiles linked              ${count((a) => a.socialCount === 0)}  ${pct(count((a) => a.socialCount === 0))}`);
console.log(`  no mobile viewport                     ${count((a) => !a.mobileViewport)}  ${pct(count((a) => !a.mobileViewport))}`);
console.log(`  no HTTPS                               ${count((a) => !a.httpsOk)}`);
const stale = audited.filter((c) => c.siteAudit?.copyrightYear && c.siteAudit.copyrightYear < 2025);
console.log(`  copyright 2024 or older                ${stale.length}  ${pct(stale.length)}`);
const scores = audited.map((c) => c.siteAudit!.score).sort((a, b) => a - b);
console.log(`\nsite score: min ${scores[0]} · median ${scores[Math.floor(scores.length/2)]} · max ${scores[scores.length-1]}`);
console.log(`\nfree-mail addresses (gmail/yahoo/hotmail) as the business inbox:`);
const free = live.filter((c) => c.contacts.some((x) => /gmail|yahoo|hotmail|outlook/i.test(x.email ?? "")));
console.log(`  ${free.length} of ${live.filter((c) => c.contacts.some((x) => x.email)).length} with an email`);
await db.$disconnect();
