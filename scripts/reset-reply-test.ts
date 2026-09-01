/** Clear the mis-ingested inbound rows and the false reply attributions. */
import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

const bad = await db.message.deleteMany({ where: { businessId: biz.id, direction: "INBOUND" } });
console.log(`removed ${bad.count} inbound rows (2 were our own sent copies, 1 a real reply)`);

const cleared = await db.message.updateMany({
  where: { businessId: biz.id, direction: "OUTBOUND", repliedAt: { not: null } },
  data: { repliedAt: null },
});
console.log(`cleared ${cleared.count} false reply attributions`);

const mb = await db.mailbox.findFirst({ where: { businessId: biz.id, provider: "gmail" } });
if (mb) await db.mailbox.update({ where: { id: mb.id }, data: { historyCursor: null } });
console.log(`reset the inbox cursor so the reply is re-read`);
await db.$disconnect();
