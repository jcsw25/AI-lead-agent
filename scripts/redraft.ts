/** Discard existing drafts and rewrite them with the current prompt. */
import { db } from "@/lib/db";
import { draftForSupplier } from "@/lib/outreach/draft";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const drafts = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND" },
  select: { id: true, contact: { select: { companyId: true } } },
});
console.log(`rewriting ${drafts.length} drafts\n`);

for (const d of drafts) {
  await db.message.update({ where: { id: d.id }, data: { status: "CANCELLED" } });
  await db.introduction.updateMany({ where: { outreachMessageId: d.id }, data: { outreachMessageId: null } });
  if (d.contact?.companyId) await draftForSupplier(biz.id, d.contact.companyId);
}

const fresh = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND" },
  include: { contact: { include: { company: { select: { name: true } } } } },
});
for (const m of fresh) {
  console.log(`${"─".repeat(72)}`);
  console.log(`To:      ${m.contact?.company.name} <${m.contact?.email}>`);
  console.log(`Subject: ${m.subject}`);
  console.log(`${"─".repeat(72)}`);
  console.log(m.bodyText);
  console.log();
}
await db.$disconnect();
