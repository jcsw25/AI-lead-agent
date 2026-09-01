import { db } from "@/lib/db";
import { logChange } from "@/lib/changelog";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const needs = await db.need.count({ where: { businessId: biz.id } });
const entries = [
  {
    area: "AGENT" as const,
    title: "Demand probe — the first email now asks instead of pitching",
    before:
      "The first email to a buyer pitched a supplier: 'I work with a company called X, want an introduction?' It made a claim about a relationship, and it guessed that the buyer wanted something nobody had asked them about.",
    after:
      "A 40-60 word email asking one question — 'who looks after your aircon servicing at the moment?' Names no supplier, offers nothing, quotes no terms. A reply of 'we're happy with ours' is a success: it names the incumbent and dates the next conversation.",
    why:
      "Guessing at demand and pitching it is two guesses. Asking removes the first one for the price of an email, and a supplier approached afterwards is being offered work rather than sold a promise.",
    impact: `${needs} suspected needs are now askable. Probe reply rate becomes the number the model is judged on.`,
  },
  {
    area: "FIX" as const,
    title: "Two quality checkers disagreed about length",
    before:
      "checkDraft rejected anything under 60 words as 'too thin to explain the opportunity'. The probe spec targets under 80 and ideally 40 — so correct probes were flagged as faults on the first real run.",
    after: "checkDraft takes a minWords floor. Probes pass 30; outreach emails keep 60.",
    why: "A rule calibrated for one kind of email silently mislabelled another. The general checker was the one that was wrong.",
  },
];
let n = 0;
for (const e of entries) {
  if (await db.changeLog.findFirst({ where: { title: e.title } })) continue;
  await logChange(biz.id, e);
  n++;
}
console.log(`${n} entries logged · ${await db.changeLog.count()} total`);
await db.$disconnect();
