/**
 * Onboard a supplier who said yes, then draft to their buyers.
 *
 *   npm run onboard -- "MET" --rate 10
 *   npm run onboard -- "MET" --rate 10 --draft 3
 */
import { db } from "@/lib/db";
import { onboardSupplier } from "@/lib/outreach/onboard";
import { draftSideB } from "@/lib/outreach/draft-buyer";

const argv = process.argv.slice(2);
const val = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const name = argv.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
if (!name) { console.error('usage: npm run onboard -- "<company name>" [--rate 10] [--draft 3]'); process.exit(1); }

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const company = await db.company.findFirstOrThrow({
  where: { name: { contains: name, mode: "insensitive" } },
  select: { id: true, name: true },
});

const r = await onboardSupplier(biz.id, company.id, { commissionRate: Number(val("rate") ?? 10) });
console.log(`onboarded ${company.name}`);
console.log(`  introductions now live   ${r.introductionsActivated}`);
console.log(`  matches created          ${r.matchesCreated}`);

const drafts = Number(val("draft") ?? 0);
if (drafts > 0) {
  console.log(`\ndrafting to ${drafts} buyers...`);
  const d = await draftSideB(biz.id, { limit: drafts, companyAId: company.id });
  console.log(`  drafted ${d.drafted} · $${d.costUsd.toFixed(3)}`);
  for (const s of d.skipped) console.log(`  skipped ${s.buyer}: ${s.why}`);

  const ms = await db.message.findMany({
    where: { businessId: biz.id, status: "DRAFT" },
    orderBy: { createdAt: "desc" }, take: drafts,
    include: { contact: { include: { company: { select: { name: true } } } } },
  });
  for (const m of ms) {
    const g = m.gateDecision as { side?: string; toneViolations?: Array<{ rule: string }> } | null;
    if (g?.side !== "B") continue;
    console.log(`\n${"=".repeat(74)}`);
    console.log(`${m.contact?.company.name}  <${m.contact?.email}>`);
    console.log(`Subject: ${m.subject}`);
    console.log(`${(m.bodyText ?? "").split(/\s+/).filter(Boolean).length} words · ${g?.toneViolations?.length ? "FLAGGED: " + g.toneViolations.map((v) => v.rule).join(", ") : "passes all tone checks"}`);
    console.log(`${"=".repeat(74)}`);
    console.log(m.bodyText);
  }
}
await db.$disconnect();
