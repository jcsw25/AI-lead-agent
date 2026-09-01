import { PrismaClient } from "@prisma/client";
import { sendThroughGate, contentGroupId } from "../src/lib/gate";

const db = new PrismaClient();

/**
 * This test writes real rows: it suppresses a contact, creates messages, and
 * pushes them through the gate, which appends to the send ledger. That was
 * harmless when the database held mock companies on reserved .test domains. It
 * is not harmless now — running it against live data would permanently suppress
 * a real prospect and record sends that never happened, corrupting the bulk
 * threshold counters the compliance gate depends on.
 *
 * So it refuses unless the database is clearly a test one.
 */
const realCompanies = await db.company.count({
  where: { primaryDomain: { not: { endsWith: ".test" } } },
});
if (realCompanies > 0 && !process.argv.includes("--i-know-this-writes-to-live-data")) {
  console.error(
    `Refusing to run: ${realCompanies} real companies in this database.
` +
      `This test suppresses a contact and writes send-ledger entries.
` +
      `Use a scratch database, or pass --i-know-this-writes-to-live-data.`,
  );
  process.exit(1);
}

const biz = await db.business.findFirstOrThrow();
const results: string[] = [];

async function draft(contactId: string, subject: string, body: string) {
  const m = await db.message.create({
    data: { businessId: biz.id, contactId, channel: "EMAIL", direction: "OUTBOUND",
            status: "PENDING_APPROVAL", subject, bodyText: body },
  });
  return m.id;
}

const contacts = await db.contact.findMany({ take: 4, where: { email: { not: null } } });

// 1. suppression
const victim = contacts[0];
await db.suppressionEntry.create({
  data: { businessId: biz.id, scope: "BUSINESS", reason: "UNSUBSCRIBE", email: victim.email! },
});
const d1 = await draft(victim.id, "Test suppressed", "Body one, unique enough.");
const r1 = await sendThroughGate(d1);
results.push(`suppression:      ${r1.allowed ? "FAIL (sent!)" : "PASS — " + r1.reasons.at(-1)}`);

// 2. provenance — contact with no source and unverified
const orphan = await db.contact.create({
  data: { companyId: contacts[1].companyId, fullName: "No Source", email: "nosource@nowhere.test",
          verification: "UNVERIFIED", isBusinessContactInfo: true },
});
const d2 = await draft(orphan.id, "Test provenance", "Body two, also unique.");
const r2 = await sendThroughGate(d2);
results.push(`provenance:       ${r2.allowed ? "FAIL (sent!)" : "PASS — " + r2.reasons.at(-1)}`);

// 3. bulk threshold — drop the limit to 2 and send 3 identical emails
await db.sendPolicy.update({ where: { businessId: biz.id }, data: { bulkPer24h: 2 } });
const SUBJ = "Identical template subject line";
const BODY = "Exactly the same body text for every single recipient in this batch.";
let blockedAt = 0;
for (let n = 0; n < 3; n++) {
  const c = contacts[(n % 2) + 2];
  const id = await draft(c.id, SUBJ, BODY);
  const r = await sendThroughGate(id);
  if (!r.allowed) { blockedAt = n + 1; results.push(`bulk threshold:   PASS — blocked at #${n + 1}: ${r.reasons.at(-1)?.slice(0, 90)}`); break; }
}
if (!blockedAt) results.push("bulk threshold:   FAIL (never blocked)");

// 4. tailored emails must NOT aggregate
const g1 = contentGroupId("Christmas hampers for Acme Bank", "Hi Jane, your client appreciation period...");
const g2 = contentGroupId("Automation audit for Bolt Logistics", "Hi Sam, you are hiring three ops coordinators...");
results.push(`distinct grouping:${g1 !== g2 ? " PASS — different buckets" : " FAIL — collapsed together"}`);

await db.sendPolicy.update({ where: { businessId: biz.id }, data: { bulkPer24h: 100 } });
console.log(results.join("\n"));
await db.$disconnect();
