/**
 * Send one real email to yourself, through the real path.
 *
 *   npm run selftest              # copy the newest draft's copy
 *   npm run selftest -- --draft 3 # copy the 3rd draft in the queue
 *
 * Everything a recipient would experience: the compliance gate, suppression
 * check, bulk-threshold evaluation, unsubscribe footer, and the Gmail send.
 * The only thing changed is who it goes to.
 *
 * Your six real drafts are left untouched. A copy is made against a dedicated
 * self-test contact, which is written to the database pre-rejected so it can
 * never drift into qualification, introductions or a future campaign.
 */
import { db } from "@/lib/db";
import { sendThroughGate } from "@/lib/gate";
import { activeMailbox } from "@/lib/gmail-auth";

const argv = process.argv.slice(2);
const nth = Number(argv[argv.indexOf("--draft") + 1]) || 1;

const biz = await db.business.findFirstOrThrow({
  orderBy: { createdAt: "asc" },
  include: { sendPolicy: true, region: true },
});

const to = biz.sendPolicy?.senderContactEmail;
if (!to) { console.error("No reply-to address on the send policy."); process.exit(1); }

const mailbox = await activeMailbox(biz.id);
console.log(`adapter   ${process.env.EMAIL_ADAPTER ?? "mock"}`);
console.log(`mailbox   ${mailbox?.address ?? "(none connected)"}`);
console.log(`sending   to yourself at ${to}\n`);

// ---- the self-test recipient -------------------------------------------
// Named so it is obvious in any list, and immediately marked REJECTED so the
// qualifier, the matcher and the drafters all skip it.
const SELF_NAME = "Self test (do not contact)";
let company = await db.company.findFirst({ where: { name: SELF_NAME } });
if (!company) {
  company = await db.company.create({
    data: {
      name: SELF_NAME,
      regionId: biz.regionId,
      countryCode: biz.region.code,
      verification: "UNVERIFIED",
      industry: null,
    },
  });
}
await db.qualification.upsert({
  where: { businessId_companyId: { businessId: biz.id, companyId: company.id } },
  create: {
    businessId: biz.id, companyId: company.id,
    status: "REJECTED", grade: "D", score: 0, rejectionReason: "NOT_A_BUSINESS",
    factors: [] as object, explanation: "Internal self-test recipient. Never a lead.", modelVersion: 0,
  },
  update: { status: "REJECTED", rejectionReason: "NOT_A_BUSINESS" },
});

let contact = await db.contact.findFirst({ where: { companyId: company.id, email: to } });
if (!contact) {
  contact = await db.contact.create({
    data: {
      companyId: company.id,
      fullName: "Self test",
      jobTitle: "Internal",
      email: to,
      sourceType: "manual",
      isBusinessContactInfo: true,
      verification: "VERIFIED",
    },
  });
}

// ---- borrow the copy from a real draft ---------------------------------
const drafts = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND", contactId: { not: contact.id } },
  orderBy: { createdAt: "desc" },
  include: { contact: { include: { company: { select: { name: true } } } } },
});
if (!drafts.length) { console.error("No drafts to copy. Run npm run draft first."); process.exit(1); }

const source = drafts[Math.min(nth, drafts.length) - 1];
console.log(`copying draft written for: ${source.contact?.company.name}`);
console.log(`subject: ${source.subject}\n`);

const test = await db.message.create({
  data: {
    businessId: biz.id,
    contactId: contact.id,
    mailboxId: mailbox?.id,
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "DRAFT",
    subject: `[self-test] ${source.subject}`,
    bodyText: source.bodyText,
  },
});

// ---- through the real gate ---------------------------------------------
const decision = await sendThroughGate(test.id);

console.log(`gate decision      ${decision.allowed ? "ALLOWED" : "BLOCKED"}`);
console.log(`reasons            ${decision.reasons.join(" | ")}`);
console.log(`<ADV> prefix       ${decision.advApplied ? "applied (bulk threshold crossed)" : "not needed"}`);
console.log(`content group      ${decision.contentGroupId}`);
if (decision.counts) console.log(`bulk counts        ${JSON.stringify(decision.counts)}`);

const after = await db.message.findUniqueOrThrow({ where: { id: test.id } });
console.log(`\nmessage status     ${after.status}`);
console.log(`provider id        ${after.providerMessageId ?? "(none)"}`);
console.log(`unsubscribe url    ${after.unsubscribeUrl ?? "(none)"}`);
if (after.blockedReason) console.log(`blocked reason     ${after.blockedReason}`);

const ledger = await db.sendLedgerEntry.count({ where: { businessId: biz.id } });
console.log(`send ledger rows   ${ledger}`);

if (after.status === "SENT") {
  console.log(`\n${"─".repeat(72)}\nExactly what landed in your inbox:\n${"─".repeat(72)}`);
  console.log(`Subject: ${after.subject}\n`);
  console.log(after.bodyText);
  console.log(`${"─".repeat(72)}`);
  console.log(`\nCheck ${to}. Then reply to it and run "npm run replies" to watch the classifier.`);
}

await db.$disconnect();
