import { db } from "@/lib/db";
const ms = await db.message.findMany({
  where: { status: "DRAFT", direction: "OUTBOUND" },
  orderBy: { createdAt: "asc" },
  include: { contact: { include: { company: { select: { name: true, description: true } } } } },
});
for (const m of ms) {
  const w = (m.bodyText ?? "").split(/\s+/).filter(Boolean).length;
  const g = m.gateDecision as { toneViolations?: Array<{ rule: string }> } | null;
  console.log(`\n${"=".repeat(76)}`);
  console.log(`${m.contact?.company.name}  <${m.contact?.email}>`);
  console.log(`Subject: ${m.subject}`);
  console.log(`${w} words · ${g?.toneViolations?.length ? "FLAGGED: " + g.toneViolations.map((v) => v.rule).join(", ") : "passes all tone checks"}`);
  console.log(`evidence: ${m.contact?.company.description ? "site description on file" : "NONE — must open generically"}`);
  console.log(`${"=".repeat(76)}`);
  console.log(m.bodyText);
}
await db.$disconnect();
