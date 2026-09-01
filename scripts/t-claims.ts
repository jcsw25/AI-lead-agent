import { db } from "@/lib/db";
for (const n of ["Ngeecheong", "Met"]) {
  const c = await db.company.findFirstOrThrow({ where: { name: n }, select: { name: true, description: true } });
  console.log(`\n${c.name}:\n  ${(c.description ?? "(none)").slice(0, 300)}`);
}
const drafts = await db.message.findMany({
  where: { status: "DRAFT", direction: "OUTBOUND" },
  select: { subject: true, gateDecision: true, bodyText: true },
});
console.log(`\n\nunresolved tone violations:`);
for (const d of drafts) {
  const g = d.gateDecision as { toneViolations?: Array<{ rule: string }> } | null;
  const words = (d.bodyText ?? "").split(/\s+/).filter(Boolean).length;
  console.log(`  ${String(words).padStart(3)}w  ${(d.subject ?? "").slice(0, 40).padEnd(42)} ${g?.toneViolations?.map((v) => v.rule).join(", ") ?? "clean"}`);
}
await db.$disconnect();
