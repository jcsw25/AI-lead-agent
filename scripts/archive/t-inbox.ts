import { db } from "@/lib/db";
import { getEmailAdapter } from "@/adapters/email";
import { accessTokenFor, activeMailbox } from "@/lib/gmail-auth";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const mb = await activeMailbox(biz.id);
const adapter = getEmailAdapter({ accessToken: await accessTokenFor(mb!.id) });
const { messages } = await adapter.fetchSince!(null);

console.log(`fetched ${messages.length}\n`);
const mine = messages.filter((m) => m.fromEmail.includes("jasoncsw25"));
console.log(`from jasoncsw25: ${mine.length}`);
for (const m of mine.slice(0, 5)) {
  console.log(`  from="${m.fromEmail}"  subject="${m.subject}"  ${m.receivedAt.toLocaleTimeString()}`);
  console.log(`     snippet: ${m.text.slice(0, 60)}`);
}

console.log(`\nnewest 5 overall:`);
for (const m of messages.slice(0, 5)) console.log(`  ${m.receivedAt.toLocaleTimeString()}  ${m.fromEmail.padEnd(34)} ${m.subject.slice(0, 40)}`);

const c = await db.contact.findFirst({ where: { email: { equals: "jasoncsw25@gmail.com", mode: "insensitive" } } });
console.log(`\nself-test contact in db: ${c ? `${c.id} (${c.email})` : "NOT FOUND"}`);
console.log(`inbound messages stored: ${await db.message.count({ where: { direction: "INBOUND" } })}`);
await db.$disconnect();
