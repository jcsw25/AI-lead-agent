/** Cancel every unsent draft and rewrite it through the current, gated writers. */
import { db } from "@/lib/db";
import { runOutreachWriter } from "@/agents/outreach";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const drafts = await db.message.findMany({
  where: { businessId: biz.id, status: { in: ["DRAFT", "PENDING_APPROVAL"] }, direction: "OUTBOUND" },
  select: { id: true, matchId: true, subject: true, contact: { select: { company: { select: { name: true } } } } },
});
console.log(`${drafts.length} unsent drafts\n`);

for (const d of drafts) {
  console.log(`  cancelling: ${d.contact?.company.name} — "${d.subject}"`);
  await db.message.update({ where: { id: d.id }, data: { status: "CANCELLED", blockedReason: "Rewritten under current tone rules" } });
  if (d.matchId) {
    try { await runOutreachWriter(biz.id, d.matchId); } catch (e) { console.log(`     rewrite failed: ${e instanceof Error ? e.message.slice(0, 90) : e}`); }
  }
}

const fresh = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND" },
  include: { contact: { include: { company: { select: { name: true } } } } },
});
for (const m of fresh) {
  const g = m.gateDecision as { toneViolations?: Array<{ rule: string }> } | null;
  console.log(`\n${"=".repeat(74)}`);
  console.log(`${m.contact?.company.name} <${m.contact?.email}>`);
  console.log(`Subject: ${m.subject}`);
  console.log(`${(m.bodyText ?? "").split(/\s+/).filter(Boolean).length} words · ${g?.toneViolations?.length ? "FLAGGED: " + g.toneViolations.map((v) => v.rule).join(", ") : "passes all tone checks"}`);
  console.log(`${"=".repeat(74)}`);
  console.log(m.bodyText);
}
await db.$disconnect();
