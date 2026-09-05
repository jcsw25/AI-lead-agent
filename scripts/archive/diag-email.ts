import { db } from "@/lib/db";

/**
 * Which emails would reach the wrong company?
 *
 * A free-mail address (gmail, yahoo) on a company's own site is normal for an
 * SME and perfectly correct. An address on a DIFFERENT business domain is not —
 * it means the crawler picked up a partner, a directory embed, or the web
 * designer's own address, and sending to it puts the wrong company's name in
 * front of a stranger.
 */

const FREEMAIL = new Set([
  "gmail.com", "hotmail.com", "yahoo.com", "yahoo.com.sg", "outlook.com", "live.com",
  "hotmail.sg", "yahoo.com.hk", "icloud.com", "qq.com", "163.com",
]);

const companies = await db.company.findMany({
  where: { contacts: { some: { email: { not: null } } } },
  select: {
    name: true, primaryDomain: true,
    contacts: { where: { email: { not: null } }, select: { email: true } },
    introsAsA: { select: { id: true } },
    introsAsB: { select: { id: true } },
  },
});

let freemail = 0;
let onOwnDomain = 0;
const mismatched: Array<{ name: string; domain: string; email: string; live: boolean }> = [];

for (const c of companies) {
  const domain = (c.primaryDomain ?? "").toLowerCase();
  const stem = domain.split(".")[0];
  const live = c.introsAsA.length + c.introsAsB.length > 0;

  for (const ct of c.contacts) {
    const e = (ct.email ?? "").toLowerCase();
    const eDomain = e.split("@")[1] ?? "";
    if (!eDomain) continue;

    if (FREEMAIL.has(eDomain)) { freemail++; continue; }
    if (!stem) continue;

    const eStem = eDomain.split(".")[0];
    if (eDomain.includes(stem) || domain.includes(eStem)) { onOwnDomain++; continue; }

    mismatched.push({ name: c.name, domain, email: e, live });
  }
}

console.log(`emails on the company's own domain   ${onOwnDomain}`);
console.log(`free-mail (gmail etc) — legitimate   ${freemail}`);
console.log(`on a DIFFERENT business domain       ${mismatched.length}`);
console.log(`  ...of which are in an introduction ${mismatched.filter((m) => m.live).length}`);

console.log(`\nwrong-company risks currently in play:`);
for (const m of mismatched.filter((x) => x.live).slice(0, 15)) {
  console.log(`  ${m.name.slice(0, 30).padEnd(32)} ${m.domain.padEnd(28)} ${m.email}`);
}

await db.$disconnect();
