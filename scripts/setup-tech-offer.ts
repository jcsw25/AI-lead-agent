/**
 * Set up the tech-services offer to aircon and HVAC companies.
 *
 *   npx tsx scripts/setup-tech-offer.ts --draft 4
 *
 * This is a DIRECT sale, not a brokered introduction. We are the supplier, so
 * the Supplier row is marked isSelf — which the outreach writer reads to decide
 * whether it is offering our own work or introducing somebody else's. Getting
 * that flag wrong produces an email that says "I work with a company who..."
 * about ourselves, which reads as evasive at best.
 *
 * Targets are chosen by MEASURED weakness rather than by industry alone. An
 * aircon firm with no enquiry form on its site is a company that cannot take a
 * booking from a customer who is ready to buy — that is a checkable fact, it is
 * the honest opening line, and it is the thing we would actually fix.
 */
import { db } from "@/lib/db";
import { runOutreachWriter } from "@/agents/outreach";
import { logChange } from "@/lib/changelog";

const argv = process.argv.slice(2);
const nDrafts = Number(argv[argv.indexOf("--draft") + 1]) || 4;

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

// ---- 1. we are the supplier ------------------------------------------------
const existingSupplier = await db.supplier.findFirst({
  where: { businessId: biz.id, isSelf: true },
  select: { id: true },
});
const supplier = existingSupplier
  ? await db.supplier.update({ where: { id: existingSupplier.id }, data: { isActive: true } })
  : await db.supplier.create({
      data: {
        businessId: biz.id,
        name: biz.name,
        isSelf: true,
        contactEmail: (await db.sendPolicy.findUnique({ where: { businessId: biz.id } }))?.senderContactEmail,
        notes: "Software built for aircon and HVAC servicing firms, fitted to how they already work.",
        defaultCommissionRate: null,
        isActive: true,
      },
    });
console.log(`supplier: ${supplier.name} (our own services)`);

// ---- 2. what we sell -------------------------------------------------------
// painSignals are what makes a company a candidate. They are observable from
// outside, which is the whole point — we can tell who needs this before we speak
// to them.
const PRODUCTS = [
  {
    name: "Automated service reminders",
    description:
      "Units get serviced every three to four months. We message the customer at the right interval on WhatsApp or SMS " +
      "with one tap to rebook, so the next job does not depend on the customer remembering. Sits on top of whatever " +
      "records they already keep.",
    priceMin: 3000, priceMax: 9000,
    skills: ["WhatsApp Business API", "scheduling", "customer records"],
    painSignals: ["no enquiry form", "no clickable email or phone link", "no booking flow", "paper job sheets"],
    typicalEngagementDays: 20,
  },
  {
    name: "Smart job scheduling and dispatch",
    description:
      "Assign technicians to jobs, group them by area so a crew is not crossing the island twice, and see the whole day " +
      "at a glance. Replaces the whiteboard and the group chat.",
    priceMin: 6000, priceMax: 20000,
    skills: ["scheduling", "route grouping", "technician mobile app"],
    painSignals: ["manual scheduling", "no job records", "paper job sheets"],
    typicalEngagementDays: 40,
  },
  {
    name: "Follow-up automation",
    description:
      "Quotes that get chased on their own, review requests the evening after a completed job, and invoices that " +
      "remind the customer without anyone having to feel awkward about it.",
    priceMin: 2500, priceMax: 8000,
    skills: ["messaging automation", "quote tracking", "review generation"],
    painSignals: ["no enquiry form", "no social profiles linked", "no structured data"],
    typicalEngagementDays: 15,
  },
  {
    name: "AI call answering",
    description:
      "Nobody in this trade can answer the phone while they are on a roof. An assistant picks up, takes the address, " +
      "the unit count and the preferred slot, writes it into the schedule and texts a confirmation. The missed call " +
      "stops being a lost job.",
    priceMin: 4000, priceMax: 15000,
    skills: ["voice AI", "call handling", "booking capture"],
    painSignals: ["no enquiry form", "phone only contact route", "single-person office"],
    typicalEngagementDays: 25,
  },
];

const products = [];
for (const p of PRODUCTS) {
  const dupe = await db.supplierProduct.findFirst({ where: { supplierId: supplier.id, name: p.name } });
  const row = dupe
    ? await db.supplierProduct.update({ where: { id: dupe.id }, data: { ...p, kind: "SERVICE", isActive: true } })
    : await db.supplierProduct.create({ data: { supplierId: supplier.id, ...p, kind: "SERVICE", currency: "SGD" } });
  products.push(row);
  console.log(`  service: ${row.name}  SGD ${Number(row.priceMin)}-${Number(row.priceMax)}`);
}

// ---- 3. who needs it, by measured weakness ---------------------------------
const candidates = await db.company.findMany({
  where: {
    industry: { in: ["aircon servicing", "HVAC"], mode: "insensitive" },
    contacts: { some: { email: { not: null } } },
    qualifications: { some: { businessId: biz.id, status: { not: "REJECTED" } } },
    siteAudit: { reachable: true },
  },
  select: {
    id: true, name: true, description: true,
    siteAudit: { select: { hasContactForm: true, hasEmailLink: true, hasPhoneLink: true, findings: true, score: true } },
    qualifications: { where: { businessId: biz.id }, select: { score: true }, take: 1 },
  },
  take: 200,
});

// Rank by how clearly they need this, not by how good their site is.
const scored = candidates
  .map((c) => {
    const a = c.siteAudit!;
    let need = 0;
    if (!a.hasContactForm) need += 3;          // cannot take a booking at all
    if (!a.hasEmailLink && !a.hasPhoneLink) need += 2;
    need += Math.min(2, ((a.findings as string[] | null) ?? []).length / 3);
    return { ...c, need, quality: c.qualifications[0]?.score ?? 0 };
  })
  .filter((c) => c.need >= 3)
  .sort((a, b) => b.need - a.need || b.quality - a.quality);

console.log(`\n${scored.length} aircon/HVAC firms with a measurable gap we would fix`);

// ---- 4. a Match per company, using the strongest matching service -----------
let made = 0;
for (const c of scored.slice(0, nDrafts * 2)) {
  const a = c.siteAudit!;
  // Pick the service that answers the weakness we can actually see.
  const product = !a.hasContactForm && !a.hasEmailLink && !a.hasPhoneLink
    ? products.find((p) => p.name.startsWith("AI call"))!
    : !a.hasContactForm
      ? products.find((p) => p.name.startsWith("Automated service"))!
      : products.find((p) => p.name.startsWith("Follow-up"))!;

  const prospect = await db.prospect.findUnique({
    where: { businessId_companyId: { businessId: biz.id, companyId: c.id } },
    select: { id: true, contacts: { select: { id: true }, take: 1 } },
  });
  if (!prospect) continue;

  // The outreach writer resolves its recipient through ProspectContact, not
  // through the company. Scraped contacts land on the Company, so without this
  // link every draft fails with "no contact identified" even though the email
  // address is sitting right there.
  if (!prospect.contacts.length) {
    const best = await db.contact.findFirst({
      where: { companyId: c.id, email: { not: null }, NOT: { email: { startsWith: "unknown-" } } },
      orderBy: { verification: "asc" },
      select: { id: true },
    });
    if (!best) continue;
    await db.prospectContact.create({
      data: { prospectId: prospect.id, contactId: best.id, isPrimary: true, roleGuess: "gatekeeper",
              rationale: "Only published contact route on the company site." },
    });
  }

  const dupe = await db.match.findFirst({
    where: { businessId: biz.id, prospectId: prospect.id, supplierProductId: product.id },
    select: { id: true },
  });
  if (dupe) continue;

  const observed = ((a.findings as string[] | null) ?? [])[0] ?? "no enquiry form on the site";

  await db.match.create({
    data: {
      businessId: biz.id,
      prospectId: prospect.id,
      supplierProductId: product.id,
      fitScore: Math.min(1, c.need / 5),
      rationale:
        `${c.name} is an operating aircon firm whose website cannot take a booking. ` +
        `${product.name} is the smallest change that fixes it.`,
      angle: "observed_gap",
      // Verbatim from the audit. Not a guess, and checkable by the reader.
      observedPain: observed,
      firstAsk: "a short call to see how they take bookings today",
      estimatedDealValue: product.priceMin,
      // NONE: our own service, so the whole fee is revenue rather than a cut.
      commissionModel: "NONE",
      currency: "SGD",
      status: "APPROVED",
    },
  });
  made++;
}
console.log(`${made} matches created`);

// ---- 5. draft ---------------------------------------------------------------
const toDraft = await db.match.findMany({
  where: {
    businessId: biz.id,
    product: { supplier: { isSelf: true } },
    messages: { none: { direction: "OUTBOUND", status: { notIn: ["CANCELLED", "FAILED"] } } },
    prospect: { contacts: { some: {} } },
  },
  orderBy: { fitScore: "desc" },
  take: nDrafts,
  select: { id: true },
});

console.log(`\ndrafting ${toDraft.length}...`);
for (const m of toDraft) {
  try {
    await runOutreachWriter(biz.id, m.id);
  } catch (e) {
    console.log(`  failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
  }
}

const drafts = await db.message.findMany({
  where: { businessId: biz.id, status: "DRAFT", direction: "OUTBOUND" },
  orderBy: { createdAt: "desc" }, take: nDrafts,
  include: { contact: { include: { company: { select: { name: true } } } } },
});
for (const d of drafts) {
  const words = (d.bodyText ?? "").split(/\s+/).filter(Boolean).length;
  console.log(`\n${"=".repeat(76)}`);
  console.log(`To: ${d.contact?.company.name} <${d.contact?.email}>`);
  console.log(`Subject: ${d.subject}   [${words} words]`);
  console.log(`${"=".repeat(76)}`);
  console.log(d.bodyText);
}

if (made > 0) {
  await logChange(biz.id, {
    area: "PIPELINE",
    title: "Approvals now shows the tech offer to aircon firms, not a brokered introduction",
    before:
      "The queue held brokered introductions — dental clinics being offered an aircon supplier. Useful for testing the mechanism, but not the business being built first.",
    after:
      `Four services defined (reminders, scheduling, follow-up automation, AI call answering) sold directly to aircon and HVAC firms. ${scored.length} companies qualify on a measured website gap; the service offered is chosen by which gap they actually have.`,
    why:
      "This is a direct sale, so the supplier is marked isSelf and the writer offers our own work rather than introducing someone else's. Targeting on an observed gap means the opening line is checkable by the person reading it.",
  });
}
await db.$disconnect();
