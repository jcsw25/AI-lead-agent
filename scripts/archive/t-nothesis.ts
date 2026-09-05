import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const qs = await db.qualification.findMany({
  where: { businessId: biz.id, rejectionReason: "NO_PAIRING_THESIS" },
  select: { company: { select: { industry: true, contacts: { select: { email: true } } } } },
});
const by = new Map<string, { n: number; withEmail: number }>();
for (const q of qs) {
  const k = q.company.industry ?? "(none)";
  const e = by.get(k) ?? { n: 0, withEmail: 0 };
  e.n++;
  if (q.company.contacts.some((c) => c.email)) e.withEmail++;
  by.set(k, e);
}
console.log(`${qs.length} companies rejected for having no A→B thesis:\n`);
for (const [k, v] of [...by.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(v.n).padStart(3)}  ${k.padEnd(34)} ${v.withEmail} with an email`);
}
await db.$disconnect();
