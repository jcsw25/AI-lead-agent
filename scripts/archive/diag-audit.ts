import { db } from "@/lib/db";

const audits = await db.siteAudit.findMany();
const n = audits.length;
if (!n) {
  console.log("no audits yet");
  process.exit(0);
}
const pct = (k: number) => `${Math.round((k / n) * 100)}%`;
const count = (f: (a: (typeof audits)[number]) => boolean) => audits.filter(f).length;

console.log(`audits            ${n}`);
console.log(`reachable         ${count((a) => a.reachable)}  ${pct(count((a) => a.reachable))}`);
console.log(`no mobile view    ${count((a) => a.reachable && !a.mobileViewport)}  ${pct(count((a) => a.reachable && !a.mobileViewport))}`);
console.log(`no enquiry form   ${count((a) => a.reachable && !a.hasContactForm)}  ${pct(count((a) => a.reachable && !a.hasContactForm))}`);
console.log(`no HTTPS          ${count((a) => a.reachable && !a.httpsOk)}`);
console.log(`no structured     ${count((a) => a.reachable && !a.hasStructured)}`);
console.log(`stale copyright   ${count((a) => a.copyrightYear !== null && a.copyrightYear < new Date().getFullYear() - 1)}`);
console.log(`no socials        ${count((a) => a.reachable && a.socialCount === 0)}`);

const scores = audits.filter((a) => a.reachable).map((a) => a.score).sort((x, y) => x - y);
const q = (p: number) => scores[Math.floor((scores.length - 1) * p)];
console.log(`\nsite score  min ${scores[0]}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  max ${scores[scores.length - 1]}`);

// How many have at least one weakness worth writing an email about?
const withFindings = audits.filter((a) => a.reachable && ((a.findings as string[] | null) ?? []).length > 0);
console.log(`\n${withFindings.length} of ${scores.length} reachable sites have at least one quotable weakness`);

const freq = new Map<string, number>();
for (const a of withFindings) {
  for (const f of ((a.findings as string[] | null) ?? [])) {
    const key = f.split("—")[0].trim();
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
}
console.log(`\nmost common weaknesses:`);
for (const [k, v] of [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}

await db.$disconnect();
