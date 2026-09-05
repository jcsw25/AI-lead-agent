import { db } from "@/lib/db";

/**
 * How much of the database is safe to put in front of a real person?
 *
 * Everything flagged here would go out under the user's own name, so the
 * question is not "is the data tidy" but "would sending this embarrass them".
 */

const companies = await db.company.findMany({
  select: {
    id: true, name: true, primaryDomain: true, industry: true,
    contacts: { select: { email: true } },
    qualifications: { select: { status: true } },
    introsAsA: { select: { id: true } },
    introsAsB: { select: { id: true } },
  },
});

// A page title that got mistaken for a company name.
const TITLE_NOISE = /^(home|overview|welcome|about( us)?|contact( us)?|index|untitled|services|our services|blog|news|shop|products?)$/i;
// SEO stuffing that survived the title cleaner.
const SEO = /\b(best|top|cheap|no\.?\s*1|#1|affordable|leading|trusted|24\/7|singapore's)\b/i;
// Not a company you can sell to.
const NOT_A_BUSINESS_TLD = /\.(gov|edu|org)(\.[a-z]{2})?$/i;
const NOT_A_BUSINESS_NAME = /\b(council|authority|ministry|association|society|federation|board|institute|university|polytechnic|wikipedia|government)\b/i;

type Flag = { kind: string; company: string; domain: string; detail: string; inPlay: boolean };
const flags: Flag[] = [];

for (const c of companies) {
  const domain = c.primaryDomain ?? "";
  const inPlay = c.introsAsA.length + c.introsAsB.length > 0 || c.qualifications.some((q) => q.status === "QUALIFIED");

  if (NOT_A_BUSINESS_TLD.test(domain) || NOT_A_BUSINESS_NAME.test(c.name)) {
    flags.push({ kind: "not a business", company: c.name, domain, detail: "regulator, association or institution", inPlay });
  }
  if (TITLE_NOISE.test(c.name.trim())) {
    flags.push({ kind: "page title as name", company: c.name, domain, detail: "the crawler took a nav label", inPlay });
  } else if (SEO.test(c.name)) {
    flags.push({ kind: "SEO title as name", company: c.name, domain, detail: "marketing copy, not a legal name", inPlay });
  }
  if (c.name.includes(":") || c.name.length > 45) {
    flags.push({ kind: "malformed name", company: c.name.slice(0, 50), domain, detail: "title fragment or overlong", inPlay });
  }

  // An email on a different domain than the company's own site.
  const base = domain.split(".")[0].toLowerCase();
  for (const ct of c.contacts) {
    if (!ct.email || !base) continue;
    const eDomain = ct.email.split("@")[1]?.toLowerCase() ?? "";
    if (eDomain && !eDomain.includes(base) && !domain.includes(eDomain.split(".")[0])) {
      flags.push({ kind: "email on another domain", company: c.name, domain, detail: ct.email, inPlay });
    }
  }
}

const byKind = new Map<string, { total: number; inPlay: number }>();
for (const f of flags) {
  const e = byKind.get(f.kind) ?? { total: 0, inPlay: 0 };
  e.total++;
  if (f.inPlay) e.inPlay++;
  byKind.set(f.kind, e);
}

console.log(`${companies.length} companies checked\n`);
console.log("issue".padEnd(28) + "total".padStart(7) + "  qualified or in an introduction");
for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1].inPlay - a[1].inPlay)) {
  console.log(k.padEnd(28) + String(v.total).padStart(7) + String(v.inPlay).padStart(9));
}

const affected = new Set(flags.filter((f) => f.inPlay).map((f) => f.company));
console.log(`\n${affected.size} distinct companies that are live AND flagged`);

console.log(`\nexamples you would actually email:`);
for (const f of flags.filter((x) => x.inPlay).slice(0, 14)) {
  console.log(`  ${f.kind.padEnd(24)} ${f.company.slice(0, 34).padEnd(36)} ${f.detail.slice(0, 42)}`);
}

await db.$disconnect();
