import { db } from "@/lib/db";

/**
 * CSV of the pair database. This is the Google Sheets bridge: export here, then
 * File > Import in Sheets. A live Sheets sync needs Google OAuth, which is the
 * same consent flow the Gmail adapter is waiting on.
 */
export async function GET() {
  const business = await db.business.findFirst({ orderBy: { createdAt: "asc" } });
  if (!business) return new Response("No business", { status: 404 });

  const leads = await db.supplierLead.findMany({
    where: { businessId: business.id },
    include: { company: { include: { contacts: true } }, pairing: true },
    orderBy: [{ contactScore: "desc" }],
  });

  const headers = [
    "Company", "Website", "Domain", "Status", "Contact score", "Tier",
    "Best email", "Best phone", "Named contact?", "Contact name", "Contact title",
    "Supplier industry (A)", "Buyer industry (B)", "What A has", "What B needs",
    "Why now", "Timing window", "Deal low", "Deal high", "Commission %",
    "Address", "Source", "Scraped at",
  ];

  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = leads.map((l) => {
    const named = l.company.contacts.find((c) => c.jobTitle && c.jobTitle !== "General enquiries");
    return [
      l.company.name, l.company.websiteUrl, l.company.primaryDomain, l.status,
      l.contactScore, l.contactTier, l.bestEmail, l.bestPhone, l.hasNamedContact ? "yes" : "no",
      named?.fullName ?? "", named?.jobTitle ?? "",
      l.pairing?.supplierIndustry ?? "", l.pairing?.buyerIndustry ?? "",
      l.pairing?.whatAHas ?? "", l.pairing?.whatBNeeds ?? "",
      l.pairing?.trigger ?? "", l.pairing?.timingWindow ?? "",
      l.pairing?.typicalDealLow ?? "", l.pairing?.typicalDealHigh ?? "", l.pairing?.commissionRate ?? "",
      l.company.addressLine ?? "", l.source, l.scrapedAt?.toISOString().slice(0, 10) ?? "",
    ].map(esc).join(",");
  });

  return new Response([headers.join(","), ...rows].join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pair-database-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
