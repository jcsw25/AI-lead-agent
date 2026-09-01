import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const drafts = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND" },
  include: { contact: { include: { company: { select: { name: true, qualifications: { where: { businessId: biz.id }, select: { status: true } } } } } } },
});
for (const d of drafts) {
  const q = d.contact?.company.qualifications[0]?.status ?? "unscored";
  const g = d.gateDecision as { side?: string } | null;
  console.log(`  ${(g?.side === "B" ? "buyer " : "supplier")}  ${(d.contact?.company.name ?? "").slice(0,28).padEnd(30)} ${d.contact?.email?.padEnd(32)} ${q}`);
}
await db.$disconnect();
