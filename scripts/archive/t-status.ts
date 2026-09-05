import { db } from "@/lib/db";
const r = await db.message.groupBy({ by: ["status"], where: { direction: "OUTBOUND" }, _count: { _all: true } });
for (const x of r) console.log(`  ${x.status.padEnd(20)} ${x._count._all}`);
await db.$disconnect();
