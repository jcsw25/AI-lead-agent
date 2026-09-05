import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const intros = await db.introduction.findMany({
  where: { businessId: biz.id },
  select: {
    companyAId: true, fitScore: true,
    companyA: { select: { name: true, industry: true, contacts: { select: { email: true } } } },
    pairing: { select: { supplierIndustry: true, buyerIndustry: true } },
  },
});
const byA = new Map<string, { name: string; industry: string | null; email: string | null; buyers: Set<string>; best: number }>();
for (const i of intros) {
  const e = byA.get(i.companyAId) ?? {
    name: i.companyA.name, industry: i.companyA.industry,
    email: i.companyA.contacts.find((c) => c.email)?.email ?? null,
    buyers: new Set<string>(), best: 0,
  };
  e.buyers.add(i.pairing.buyerIndustry);
  e.best = Math.max(e.best, i.fitScore);
  byA.set(i.companyAId, e);
}
const list = [...byA.values()].sort((a, b) => b.best - a.best);
console.log(`distinct side-A companies to recruit   ${list.length}`);
console.log(`  ...with an email                     ${list.filter((x) => x.email).length}`);
const byInd = new Map<string, number>();
for (const x of list) if (x.email) byInd.set(x.industry ?? "?", (byInd.get(x.industry ?? "?") ?? 0) + 1);
console.log(`\nby industry:`);
for (const [k, v] of [...byInd.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log(`\ntop 8 to contact first:`);
for (const x of list.filter((y) => y.email).slice(0, 8)) {
  console.log(`  ${x.best.toFixed(2)}  ${x.name.slice(0, 28).padEnd(30)} ${(x.email ?? "").padEnd(34)} buyers: ${[...x.buyers].join(", ").slice(0, 40)}`);
}
await db.$disconnect();
