/**
 * Set up the BBQ-catering → freight-forwarding play, end to end, without sending.
 *
 *   npx tsx scripts/demo-bbq.ts
 *
 * Creates the supplier, the A→B thesis, the company-level introductions and the
 * buyer-side drafts, so the emails can be read in the approval queue.
 *
 * The supplier is created with a placeholder name. That is deliberate and it
 * matters: the buyer email says "I work with a company called X", and X appears
 * verbatim in something a stranger reads. A made-up name in a real send is a
 * fabrication, so the name has to be replaced with the real business before any
 * of these leave the machine.
 */
import { db } from "@/lib/db";
import { onboardSupplier } from "@/lib/outreach/onboard";
import { buildIntroductions } from "@/lib/matching/introduce";
import { draftSideB } from "@/lib/outreach/draft-buyer";
import { pairingScore } from "@/agents/pairing-generator";

const SUPPLIER_NAME = "Company A (BBQ catering) — RENAME BEFORE SENDING";
const SUPPLIER_INDUSTRY = "private bbq catering";
const BUYER_INDUSTRY = "logistics and freight forwarding";

const biz = await db.business.findFirstOrThrow({
  orderBy: { createdAt: "asc" },
  include: { region: true },
});

// ---- 1. the supplier ----------------------------------------------------
let supplierCo = await db.company.findFirst({ where: { name: SUPPLIER_NAME } });
if (!supplierCo) {
  supplierCo = await db.company.create({
    data: {
      name: SUPPLIER_NAME,
      industry: SUPPLIER_INDUSTRY,
      regionId: biz.regionId,
      countryCode: biz.region.code,
      city: biz.region.name,
      description:
        "Private barbecue catering for corporate events and staff cohesions. Cooks on site, " +
        "handles setup and clearing, works to a fixed per-head price.",
      verification: "VERIFIED",
      lastResearchedAt: new Date(),
    },
  });
  await db.contact.create({
    data: {
      companyId: supplierCo.id,
      fullName: "Company A owner",
      jobTitle: "Owner",
      email: "owner@company-a.example",
      sourceType: "manual",
      isBusinessContactInfo: true,
      verification: "VERIFIED",
    },
  });
}
console.log(`supplier: ${supplierCo.name}`);

// ---- 2. the A→B thesis --------------------------------------------------
// Written by hand rather than generated: it is one pairing and the reasoning is
// known. The trigger has to be something that happens on its own — here it is
// the calendar, which is the honest kind.
const existing = await db.pairing.findFirst({
  where: {
    businessId: biz.id,
    supplierIndustry: { equals: SUPPLIER_INDUSTRY, mode: "insensitive" },
    buyerIndustry: { equals: BUYER_INDUSTRY, mode: "insensitive" },
  },
});

const pairingData = {
  supplierIndustry: SUPPLIER_INDUSTRY,
  buyerIndustry: BUYER_INDUSTRY,
  lane: "SEASONAL" as const,
  whatAHas:
    "cooks barbecue on site for corporate groups, handles setup, service and clearing, and prices per head",
  whatBNeeds:
    "runs staff cohesion and year-end events for warehouse, driver and operations teams who are not an office lunch crowd",
  trigger:
    "Cohesion and year-end functions are planned weeks ahead and cluster from October to February, so the booking decision happens well before the event.",
  timingWindow: "October to February",
  reachA: ["owner"],
  reachB: ["whoever answers the main line", "HR", "operations manager"],
  typicalDealLow: 1500,
  typicalDealHigh: 6000,
  commissionRate: 0.1,
  demandStrength: 0.6,
  supplyEase: 0.9,
  competition: 0.5,
  confidence: 0.5,
  status: "active",
  evidence: {
    reasoning:
      "Freight and logistics firms carry large operational headcounts — warehouse, drivers, yard staff — " +
      "for whom a barbecue suits better than a seated restaurant meal. Confidence is held at 0.5: the " +
      "headcount reasoning is sound, but nothing has been verified about whether these specific firms run " +
      "cohesion events or who books them.",
  } as object,
};
const score = pairingScore({ ...pairingData, bothSidesPresent: true });

const pairing = existing
  ? await db.pairing.update({ where: { id: existing.id }, data: { ...pairingData, score } })
  : await db.pairing.create({ data: { businessId: biz.id, ...pairingData, score } });
console.log(`pairing:  ${pairing.supplierIndustry} → ${pairing.buyerIndustry}  (score ${score})`);

// ---- 3. match to the freight forwarders ---------------------------------
// Matching first: onboarding promotes a supplier's EXISTING introductions, so
// there has to be something to promote.
const m = await buildIntroductions(biz.id, { pairingId: pairing.id, perPairing: 8 });
console.log(`matched:   ${m.created} introductions created, ${m.updated} updated`);
for (const s of m.pairingsSkipped) console.log(`  skipped: ${s.pairing} — ${s.why}`);

// ---- 4. onboard, so the buyer email can honestly say "I work with" -------
const on = await onboardSupplier(biz.id, supplierCo.id, { commissionRate: 10 });
console.log(`onboarded: ${on.introductionsActivated} introductions now A_AGREED, ${on.matchesCreated} matches`);

// ---- 5. draft to the buyers --------------------------------------------
const d = await draftSideB(biz.id, { limit: 3, companyAId: supplierCo.id });
console.log(`\ndrafted ${d.drafted} buyer emails · $${d.costUsd.toFixed(3)}`);
for (const s of d.skipped) console.log(`  skipped ${s.buyer}: ${s.why}`);

const drafts = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND" },
  orderBy: { createdAt: "desc" },
  take: d.drafted,
  include: { contact: { include: { company: { select: { name: true } } } } },
});
for (const x of drafts) {
  const g = x.gateDecision as { toneViolations?: Array<{ rule: string }> } | null;
  console.log(`\n${"=".repeat(74)}`);
  console.log(`To: ${x.contact?.company.name} <${x.contact?.email}>`);
  console.log(`Subject: ${x.subject}`);
  console.log(`${(x.bodyText ?? "").split(/\s+/).filter(Boolean).length} words · ${g?.toneViolations?.length ? "FLAGGED: " + g.toneViolations.map((v) => v.rule).join(", ") : "passes tone checks"}`);
  console.log(`${"=".repeat(74)}`);
  console.log(x.bodyText);
}

console.log(`\nNothing sent. Read them at http://localhost:3000/approvals`);
await db.$disconnect();
