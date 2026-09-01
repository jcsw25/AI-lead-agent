import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const ids = (await db.message.findMany({
  where: { businessId: biz.id, status: { in: ["DRAFT", "CANCELLED"] }, direction: "OUTBOUND" },
  select: { id: true },
})).map((m) => m.id);
await db.introduction.updateMany({ where: { outreachMessageId: { in: ids } }, data: { outreachMessageId: null } });
await db.message.deleteMany({ where: { id: { in: ids } } });
console.log(`cleared ${ids.length} unsent drafts`);
await db.$disconnect();
