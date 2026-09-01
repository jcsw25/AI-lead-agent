import { db } from "@/lib/db";

/**
 * Supplier onboarding: the moment a scraped company becomes a real partner.
 *
 * Until now every company in the database was found by scraping and has agreed
 * to nothing. This is the transition — side A said yes, so they get a Supplier
 * record with agreed terms, and their introductions become live.
 *
 * That transition is what makes the buyer email honest. Before it, telling a
 * dental clinic "I work with an aircon firm who can help" would be a claim
 * about a relationship that does not exist. After it, it is true. The buyer
 * outreach is therefore gated on this and cannot run without it.
 *
 * It is also what lets an Introduction become a Match: Match links a Prospect
 * to a SupplierProduct, and the SupplierProduct only exists once somebody has
 * actually agreed to supply something.
 */

export type OnboardResult = {
  supplierId: string;
  productId: string;
  introductionsActivated: number;
  matchesCreated: number;
};

export async function onboardSupplier(
  businessId: string,
  companyId: string,
  terms: {
    commissionRate?: number;
    contactName?: string;
    contactEmail?: string;
    productName?: string;
    notes?: string;
  } = {},
): Promise<OnboardResult> {
  const company = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { contacts: { where: { email: { not: null } }, take: 1 } },
  });

  const intros = await db.introduction.findMany({
    where: { businessId, companyAId: companyId },
    include: { pairing: true },
    orderBy: { fitScore: "desc" },
  });
  if (!intros.length) throw new Error(`${company.name} is not on side A of any introduction.`);

  // Rate agreed with this supplier, defaulting to whatever the pairing assumed.
  const rate = terms.commissionRate ?? (intros[0].commissionRate ? Number(intros[0].commissionRate) * 100 : 10);

  const supplier = await db.supplier.upsert({
    where: { id: (await db.supplier.findFirst({ where: { businessId, companyId }, select: { id: true } }))?.id ?? "new" },
    create: {
      businessId,
      companyId,
      name: company.name,
      websiteUrl: company.websiteUrl,
      contactName: terms.contactName,
      contactEmail: terms.contactEmail ?? company.contacts[0]?.email ?? undefined,
      defaultCommissionRate: rate,
      notes: terms.notes,
      isActive: true,
    },
    update: {
      defaultCommissionRate: rate,
      ...(terms.contactName ? { contactName: terms.contactName } : {}),
      ...(terms.contactEmail ? { contactEmail: terms.contactEmail } : {}),
      ...(terms.notes ? { notes: terms.notes } : {}),
      isActive: true,
    },
  });

  // What they supply. Derived from the pairing rather than invented — the
  // pairing already states what side A has and what side B needs.
  const productName = terms.productName ?? company.industry ?? intros[0].pairing.supplierIndustry;
  const existingProduct = await db.supplierProduct.findFirst({
    where: { supplierId: supplier.id, name: productName },
    select: { id: true },
  });
  const product = existingProduct
    ? await db.supplierProduct.update({ where: { id: existingProduct.id }, data: { isActive: true } })
    : await db.supplierProduct.create({
        data: {
          supplierId: supplier.id,
          name: productName,
          description: intros[0].pairing.whatAHas,
          priceMin: intros[0].pairing.typicalDealLow,
          priceMax: intros[0].pairing.typicalDealHigh,
          currency: intros[0].currency,
          kind: "SERVICE",
        },
      });

  // Their introductions are now live rather than hypothetical.
  const activated = await db.introduction.updateMany({
    where: { businessId, companyAId: companyId, status: { in: ["PROPOSED", "APPROVED", "A_CONTACTED"] } },
    data: { status: "A_AGREED" },
  });

  // Promote to Match wherever the buyer already exists as a Prospect. Match is
  // the CRM-side record the rest of the pipeline (deals, campaigns) reads.
  let matchesCreated = 0;
  for (const intro of intros) {
    const prospect = await db.prospect.findUnique({
      where: { businessId_companyId: { businessId, companyId: intro.companyBId } },
      select: { id: true },
    });
    if (!prospect) continue;

    const dupe = await db.match.findFirst({
      where: { businessId, prospectId: prospect.id, supplierProductId: product.id },
      select: { id: true },
    });
    if (dupe) continue;

    await db.match.create({
      data: {
        businessId,
        prospectId: prospect.id,
        supplierProductId: product.id,
        fitScore: intro.fitScore,
        rationale: intro.rationale,
        angle: intro.pairing.lane.toLowerCase(),
        observedPain: intro.trigger,
        estimatedDealValue: intro.estimatedDealValue,
        commissionRate: rate / 100,
        estimatedCommission: intro.estimatedCommission,
        currency: intro.currency,
        status: "APPROVED",
      },
    });
    matchesCreated++;
  }

  return {
    supplierId: supplier.id,
    productId: product.id,
    introductionsActivated: activated.count,
    matchesCreated,
  };
}

/** Undo an onboarding — the supplier changed their mind. */
export async function deactivateSupplier(businessId: string, companyId: string) {
  const supplier = await db.supplier.findFirst({ where: { businessId, companyId }, select: { id: true } });
  if (!supplier) return;

  await db.supplier.update({ where: { id: supplier.id }, data: { isActive: false } });
  await db.supplierProduct.updateMany({ where: { supplierId: supplier.id }, data: { isActive: false } });
  // Introductions go back to proposed; nothing may be promised to a buyer now.
  await db.introduction.updateMany({
    where: { businessId, companyAId: companyId, status: { in: ["A_AGREED", "B_CONTACTED"] } },
    data: { status: "PROPOSED" },
  });
}
