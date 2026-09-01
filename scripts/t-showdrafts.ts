import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const ms = await db.message.findMany({
  where: { businessId: biz.id, status: { in: ["DRAFT","PENDING_APPROVAL"] }, direction: "OUTBOUND" },
  orderBy: { createdAt: "desc" },
  include: {
    contact: { include: { company: { select: { name: true } } } },
    match: { include: { product: { select: { name: true, priceMin: true } } } },
  },
});
console.log(`${ms.length} drafts\n`);
for (const m of ms) {
  const w = (m.bodyText ?? "").split(/\s+/).filter(Boolean).length;
  console.log(`${"=".repeat(78)}`);
  console.log(`To: ${m.contact?.company.name} <${m.contact?.email}>`);
  console.log(`Offering: ${m.match?.product.name ?? "(none)"}   Subject: ${m.subject}`);
  console.log(`${w} words`);
  console.log(`${"=".repeat(78)}`);
  console.log(m.bodyText);
  console.log();
}
await db.$disconnect();
