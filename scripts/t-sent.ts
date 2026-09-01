import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const sent = await db.message.findMany({
  where: { businessId: biz.id, status: "SENT" },
  orderBy: { sentAt: "desc" }, take: 3,
  include: { contact: { select: { email: true } } },
});
console.log(`messages SENT: ${sent.length}`);
for (const m of sent) {
  console.log(`  ${m.sentAt?.toLocaleTimeString()}  ${m.contact?.email}`);
  console.log(`     subject   ${m.subject}`);
  console.log(`     gmail id  ${m.providerMessageId}`);
  console.log(`     <ADV>     ${m.advPrefixApplied}`);
  console.log(`     unsub     ${m.unsubscribeUrl}`);
}
console.log(`\nsend ledger rows   ${await db.sendLedgerEntry.count({ where: { businessId: biz.id } })}`);
console.log(`audit log rows     ${await db.auditLog.count({ where: { businessId: biz.id, action: { contains: "gate" } } })}`);
console.log(`real drafts intact ${await db.message.count({ where: { businessId: biz.id, status: "DRAFT" } })}`);
await db.$disconnect();
