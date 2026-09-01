import { db } from "@/lib/db";

/**
 * Builds the three tables that go to the spreadsheet.
 *
 * One implementation, used by both the xlsx script and the live Sheets sync —
 * two would drift apart within a week and nobody would notice until the
 * numbers disagreed.
 */

type Contactish = { fullName: string; jobTitle: string | null; email: string | null; phone: string | null };

const isSimulated = (domain?: string | null, extra?: string | null) =>
  Boolean(domain?.endsWith(".test")) || Boolean(extra?.includes("simulated"));

function contactOf(contacts: Contactish[]) {
  const named = contacts.find(
    (c) => c.jobTitle && c.jobTitle !== "General enquiries" && !c.email?.startsWith("unknown-"),
  );
  const role = contacts.find((c) => c.email && !c.email.startsWith("unknown-"));
  return {
    person: named?.fullName ?? "",
    title: named?.jobTitle ?? "",
    email: named?.email ?? role?.email ?? "",
    phone: named?.phone ?? role?.phone ?? "",
  };
}

export type ExportData = {
  business: string;
  generated: string;
  introductions: Record<string, unknown>[];
  companies: Record<string, unknown>[];
  pairings: Record<string, unknown>[];
};

export async function buildExportData(businessId?: string): Promise<ExportData> {
  const biz = businessId
    ? await db.business.findUniqueOrThrow({ where: { id: businessId } })
    : await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  // Contact routes can exist as sourced Claims with no Contact row — a site
  // that publishes a number but no inbox. Without this fallback the export
  // silently drops details that were successfully scraped.
  const claimRows = await db.claim.findMany({
    where: { field: { in: ["company.phone", "company.email", "company.roleEmail"] } },
    orderBy: { observedAt: "desc" },
  });
  const claimsByCompany = new Map<string, { phone?: string; email?: string }>();
  for (const c of claimRows) {
    if (!c.companyId) continue;
    const e = claimsByCompany.get(c.companyId) ?? {};
    const v = typeof c.value === "string" ? c.value : String(c.value);
    if (c.field === "company.phone") e.phone ??= v;
    else e.email ??= v;
    claimsByCompany.set(c.companyId, e);
  }
  const withFallback = (companyId: string, c: ReturnType<typeof contactOf>) => {
    const f = claimsByCompany.get(companyId) ?? {};
    return { ...c, email: c.email || (f.email ?? ""), phone: c.phone || (f.phone ?? "") };
  };

  const [leads, matches, pairings] = await Promise.all([
    db.supplierLead.findMany({
      where: { businessId: biz.id },
      include: { company: { include: { contacts: true } }, pairing: true },
      orderBy: { contactScore: "desc" },
    }),
    db.match.findMany({
      where: { businessId: biz.id },
      include: {
        product: { include: { supplier: { include: { company: { include: { contacts: true } } } } } },
        prospect: { include: { company: { include: { contacts: true } }, play: true } },
      },
      orderBy: { fitScore: "desc" },
    }),
    db.pairing.findMany({ where: { businessId: biz.id }, orderBy: { score: "desc" } }),
  ]);

  const introductions: Record<string, unknown>[] = [];

  for (const m of matches) {
    const sup = m.product.supplier;
    const supC = sup.company
      ? contactOf(sup.company.contacts)
      : { person: "", title: "", email: sup.contactEmail ?? "", phone: "" };
    const buyC = withFallback(m.prospect.companyId, contactOf(m.prospect.company.contacts));
    introductions.push({
      status: m.status,
      a_name: sup.isSelf ? `${sup.name} (own)` : sup.name,
      a_website: sup.websiteUrl ?? sup.company?.websiteUrl ?? "",
      a_person: supC.person, a_title: supC.title,
      a_email: supC.email || (sup.contactEmail ?? ""), a_phone: supC.phone,
      a_provides: m.product.name,
      b_name: m.prospect.company.name,
      b_website: m.prospect.company.websiteUrl ?? "",
      b_industry: m.prospect.company.industry ?? m.prospect.play?.industry ?? "",
      b_person: buyC.person, b_title: buyC.title, b_email: buyC.email, b_phone: buyC.phone,
      b_address: m.prospect.company.addressLine ?? "",
      why_now: m.prospect.play?.buyingTrigger ?? "",
      timing: m.prospect.play?.timingWindow ?? "",
      deal: m.estimatedDealValue ? Number(m.estimatedDealValue) : "",
      rate: m.commissionRate ? Number(m.commissionRate) : "",
      commission: m.estimatedCommission ? Number(m.estimatedCommission) : "",
      source: "matched",
      real: isSimulated(m.prospect.company.primaryDomain, m.prospect.source) ? "SAMPLE" : "REAL",
    });
  }

  for (const l of leads) {
    const c = withFallback(l.companyId, contactOf(l.company.contacts));
    introductions.push({
      status: l.status,
      a_name: l.company.name,
      a_website: l.company.websiteUrl ?? "",
      a_person: c.person, a_title: c.title,
      a_email: l.bestEmail ?? c.email, a_phone: l.bestPhone ?? c.phone,
      a_provides: l.pairing?.whatAHas ?? l.whatTheySell ?? "",
      b_name: "", b_website: "",
      b_industry: l.pairing?.buyerIndustry ?? "",
      b_person: "", b_title: "", b_email: "", b_phone: "", b_address: "",
      why_now: l.pairing?.trigger ?? "",
      timing: l.pairing?.timingWindow ?? "",
      deal: l.pairing?.typicalDealLow ? Number(l.pairing.typicalDealLow) : "",
      rate: l.pairing?.commissionRate ? Number(l.pairing.commissionRate) : "",
      commission: "",
      source: "scraped",
      real: isSimulated(l.company.primaryDomain) ? "SAMPLE" : "REAL",
    });
  }

  const prospectCompanies = await db.company.findMany({
    where: { prospects: { some: { businessId: biz.id } } },
    include: { contacts: true },
  });
  const discovered = await db.company.findMany({
    where: { prospects: { none: {} }, supplierLeads: { none: {} } },
    include: { contacts: true },
    orderBy: { lastResearchedAt: "desc" },
    take: 500,
  });
  const allCompanies = [
    ...new Map(
      [...prospectCompanies, ...leads.map((l) => l.company), ...discovered].map((c) => [c.id, c]),
    ).values(),
  ];

  const companies = allCompanies.map((c) => {
    const ct = withFallback(c.id, contactOf(c.contacts));
    const isLead = leads.some((l) => l.companyId === c.id);
    return {
      name: c.name, website: c.websiteUrl ?? "", domain: c.primaryDomain ?? "",
      industry: c.industry ?? "", size: c.employeeBand ?? "",
      person: ct.person, title: ct.title, email: ct.email, phone: ct.phone,
      address: c.addressLine ?? "", city: c.city ?? "",
      role: isLead ? "SUPPLIER (A)" : "BUYER (B)",
      verified: c.verification,
      all_contacts: c.contacts
        .filter((x) => x.email && !x.email.startsWith("unknown-"))
        .map((x) => x.email)
        .join("; "),
      source_url: c.contacts.find((x) => x.sourceUrl)?.sourceUrl ?? c.websiteUrl ?? "",
      scraped: c.lastResearchedAt?.toISOString().slice(0, 10) ?? "",
      real: isSimulated(c.primaryDomain) ? "SAMPLE" : "REAL",
    };
  });

  const realFirst = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    (a.real === "REAL" ? 0 : 1) - (b.real === "REAL" ? 0 : 1);
  introductions.sort(realFirst);
  companies.sort(realFirst);

  return {
    business: biz.name,
    generated: new Date().toISOString().slice(0, 16).replace("T", " "),
    introductions,
    companies,
    pairings: pairings.map((p) => ({
      a_industry: p.supplierIndustry, b_industry: p.buyerIndustry, lane: p.lane,
      what_a_has: p.whatAHas, what_b_needs: p.whatBNeeds, trigger: p.trigger,
      timing: p.timingWindow ?? "", reach_a: p.reachA.join(" / "), reach_b: p.reachB.join(" / "),
      deal_low: p.typicalDealLow ? Number(p.typicalDealLow) : "",
      deal_high: p.typicalDealHigh ? Number(p.typicalDealHigh) : "",
      rate: p.commissionRate ? Number(p.commissionRate) : "",
      score: Math.round(p.score * 100), status: p.status,
    })),
  };
}
