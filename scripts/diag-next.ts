import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

const intros = await db.introduction.findMany({
  where: { businessId: biz.id },
  select: {
    companyBId: true, status: true, outreachMessageId: true,
    companyB: { select: { name: true, industry: true, contacts: { select: { email: true } } } },
  },
});
const sideB = new Map<string, { industry: string | null; hasEmail: boolean }>();
for (const i of intros) {
  sideB.set(i.companyBId, {
    industry: i.companyB.industry,
    hasEmail: i.companyB.contacts.some((c) => c.email),
  });
}
const b = [...sideB.values()];
console.log(`side-B companies in introductions   ${b.length}`);
console.log(`  ...with an email                  ${b.filter((x) => x.hasEmail).length}`);
const byInd = new Map<string, number>();
for (const x of b) if (x.hasEmail) byInd.set(x.industry ?? "?", (byInd.get(x.industry ?? "?") ?? 0) + 1);
for (const [k, v] of [...byInd.entries()].sort((a, c) => c[1] - a[1])) console.log(`     ${String(v).padStart(3)}  ${k}`);

console.log(`\nintroduction status:`);
const st = await db.introduction.groupBy({ by: ["status"], where: { businessId: biz.id }, _count: { _all: true } });
for (const s of st) console.log(`  ${s.status.padEnd(14)} ${s._count._all}`);

console.log(`\nunreachable companies (no email, no phone):`);
const noRoute = await db.qualification.count({ where: { businessId: biz.id, rejectionReason: "NO_CONTACT_ROUTE" } });
console.log(`  ${noRoute} rejected for having no contact route at all`);

console.log(`\nsuppliers onboarded            ${await db.supplier.count()}`);
console.log(`inbound messages ever          ${await db.message.count({ where: { direction: "INBOUND" } })}`);
console.log(`sends ever                     ${await db.sendLedgerEntry.count()}`);
await db.$disconnect();
