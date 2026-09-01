import { db } from "@/lib/db";
const inbound = await db.message.findMany({
  where: { direction: "INBOUND" }, orderBy: { repliedAt: "desc" },
  include: { contact: { select: { email: true, company: { select: { name: true } } } } },
});
console.log(`INBOUND messages: ${inbound.length}\n`);
for (const m of inbound) {
  console.log(`  ${m.repliedAt?.toLocaleTimeString()}  ${m.replyClass}`);
  console.log(`     from     ${m.contact?.email} (${m.contact?.company.name})`);
  console.log(`     subject  ${m.subject}`);
  console.log(`     note     ${m.classifierNotes}`);
  console.log(`     text     ${(m.bodyText ?? "").slice(0, 70)}`);
}
const out = await db.message.findMany({
  where: { direction: "OUTBOUND", status: "SENT" },
  select: { subject: true, sentAt: true, repliedAt: true },
});
console.log(`\nOUTBOUND sent, and whether a reply was matched back to them:`);
for (const m of out) console.log(`  ${m.subject?.slice(0, 42).padEnd(44)} replied: ${m.repliedAt ? m.repliedAt.toLocaleTimeString() : "no"}`);
const replied = out.filter((m) => m.repliedAt).length;
console.log(`\nreply rate  ${replied}/${out.length}  (${Math.round((replied / out.length) * 100)}%)`);
await db.$disconnect();
