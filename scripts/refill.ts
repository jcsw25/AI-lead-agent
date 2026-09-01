import { db } from "@/lib/db";
import { draftSideA } from "@/lib/outreach/draft";
import { draftSideB } from "@/lib/outreach/draft-buyer";

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const a = await draftSideA(biz.id, { limit: 4 });
console.log(`side A: drafted ${a.drafted} · $${a.costUsd.toFixed(3)}`);
for (const s of a.skipped.slice(0, 4)) console.log(`  skipped ${s.company}: ${s.why}`);
const b = await draftSideB(biz.id, { limit: 2 });
console.log(`side B: drafted ${b.drafted} · $${b.costUsd.toFixed(3)}`);
for (const s of b.skipped.slice(0, 4)) console.log(`  skipped ${s.buyer}: ${s.why}`);

const fresh = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND" },
  include: { contact: { include: { company: { select: { name: true } } } } },
});
console.log(`\n${fresh.length} drafts now in the queue:`);
for (const m of fresh) {
  const g = m.gateDecision as { toneViolations?: Array<{ rule: string }>; side?: string } | null;
  console.log(`  [${g?.side === "B" ? "buyer" : "supplier"}] ${(m.contact?.company.name ?? "").slice(0, 28).padEnd(30)} "${m.subject}"  ${g?.toneViolations?.length ? "FLAGGED" : "clean"}`);
}
await db.$disconnect();
