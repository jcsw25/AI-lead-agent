import { db } from "@/lib/db";
const s = await db.suppressionEntry.findMany({ orderBy: { createdAt: "desc" } });
for (const e of s) {
  console.log(`${e.createdAt.toLocaleTimeString()}  ${e.scope}/${e.reason}  ${e.email ?? e.domain ?? "(hashed only)"}`);
  console.log(`   note: ${e.note ?? "(none)"}`);
  console.log(`   sourceMessageId: ${e.sourceMessageId ?? "(none)"}`);
}
console.log(`\ninbound messages: ${await db.message.count({ where: { direction: "INBOUND" } })}`);
await db.$disconnect();
