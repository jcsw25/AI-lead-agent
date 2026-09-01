/**
 * Draft demand probes.
 *   npm run probe -- --limit 4
 *   npm run probe -- --category "aircon servicing" --limit 3
 */
import { db } from "@/lib/db";
import { draftProbes } from "@/lib/demand/probe";

const argv = process.argv.slice(2);
const val = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const r = await draftProbes(biz.id, { limit: Number(val("limit") ?? 4), category: val("category") });
console.log(`drafted ${r.drafted} probes · $${r.costUsd.toFixed(4)}`);
for (const s of r.skipped.slice(0, 6)) console.log(`  skipped ${s.company}: ${s.why}`);

const drafts = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND" },
  orderBy: { createdAt: "desc" }, take: r.drafted,
  include: { contact: { include: { company: { select: { name: true } } } } },
});
for (const m of drafts) {
  const g = m.gateDecision as { side?: string; question?: string; toneViolations?: Array<{ rule: string }> } | null;
  if (g?.side !== "PROBE") continue;
  const words = (m.bodyText ?? "").split(/\s+/).filter(Boolean).length;
  console.log(`\n${"=".repeat(74)}`);
  console.log(`To: ${m.contact?.company.name} <${m.contact?.email}>`);
  console.log(`Subject: ${m.subject}`);
  console.log(`${words} words · ${g?.toneViolations?.length ? "FLAGGED: " + g.toneViolations.map(v=>v.rule).join(", ") : "passes all checks"}`);
  console.log(`the question: ${g?.question}`);
  console.log(`${"=".repeat(74)}`);
  console.log(m.bodyText);
}
await db.$disconnect();
