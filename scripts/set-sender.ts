import { db } from "@/lib/db";
const email = process.argv[2];
const name = process.argv.slice(3).join(" ") || undefined;
if (!email) { console.error('usage: tsx scripts/set-sender.ts <email> [sender name]'); process.exit(1); }

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const policy = await db.sendPolicy.upsert({
  where: { businessId: biz.id },
  create: { businessId: biz.id, senderContactEmail: email, senderName: name ?? biz.name },
  update: { senderContactEmail: email, ...(name ? { senderName: name } : {}) },
});
console.log(`sender name     ${policy.senderName}`);
console.log(`reply-to        ${policy.senderContactEmail}`);
console.log(`postal address  ${policy.senderPostalAddr ?? "(not set)"}`);
console.log(`daily cap       ${policy.dailySendCap}`);
console.log(`bulk threshold  ${policy.bulkPer24h}/24h · ${policy.bulkPer30d}/30d · ${policy.bulkPer365d}/yr`);
await db.$disconnect();
