/**
 * Draft side-A recruitment emails.
 *
 *   npm run draft -- --limit 5
 *   npm run draft -- --industry "aircon servicing" --limit 10
 *
 * One email per supplier, covering every introduction they appear in.
 * Everything is created as a DRAFT — nothing sends.
 */
import { db } from "@/lib/db";
import { draftSideA } from "@/lib/outreach/draft";

const argv = process.argv.slice(2);
const val = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" }, include: { sendPolicy: true } });
console.log(`sender:   ${biz.sendPolicy?.senderName} <${biz.sendPolicy?.senderContactEmail}>`);

const t0 = Date.now();
const r = await draftSideA(biz.id, { limit: Number(val("limit") ?? 5), industry: val("industry") });
console.log(`\ndrafted ${r.drafted} in ${((Date.now() - t0) / 1000).toFixed(1)}s · $${r.costUsd.toFixed(3)}`);
if (r.skipped.length) {
  console.log(`\nskipped:`);
  for (const s of r.skipped.slice(0, 10)) console.log(`  ${s.company.slice(0, 30).padEnd(32)} ${s.why}`);
}

const drafts = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND" },
  orderBy: { createdAt: "desc" }, take: 3,
  include: { contact: { include: { company: { select: { name: true } } } } },
});
for (const d of drafts) {
  console.log(`\n${"─".repeat(74)}`);
  console.log(`To:      ${d.contact?.company.name} <${d.contact?.email}>`);
  console.log(`Subject: ${d.subject}`);
  console.log(`${"─".repeat(74)}`);
  console.log(d.bodyText);
}
console.log(`\n${await db.message.count({ where: { businessId: biz.id, status: "DRAFT" } })} drafts waiting for approval`);
await db.$disconnect();
