import { db } from "@/lib/db";

const cs = await db.company.findMany({
  select: { industry: true, primaryDomain: true, contacts: { select: { email: true, phone: true } } },
});

const by = new Map<string, { n: number; site: number; email: number; phone: number }>();
for (const c of cs) {
  const k = c.industry ?? "(unclassified)";
  const e = by.get(k) ?? { n: 0, site: 0, email: 0, phone: 0 };
  e.n++;
  if (c.primaryDomain) e.site++;
  if (c.contacts.some((x) => x.email)) e.email++;
  if (c.contacts.some((x) => x.phone)) e.phone++;
  by.set(k, e);
}

console.log("industry".padEnd(38) + "   n   site  email  phone   email%");
for (const [k, v] of [...by.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const rate = v.site ? `${Math.round((v.email / v.site) * 100)}%` : "—";
  console.log(
    k.slice(0, 36).padEnd(38) +
      String(v.n).padStart(4) +
      String(v.site).padStart(6) +
      String(v.email).padStart(7) +
      String(v.phone).padStart(7) +
      rate.padStart(9),
  );
}

await db.$disconnect();
