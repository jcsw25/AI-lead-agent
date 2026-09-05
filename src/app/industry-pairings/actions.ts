"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { ingestMany } from "@/scraper/ingest";
import { runSupplierRecruiter } from "@/agents/supplier-recruiter";

function refresh() {
  revalidatePath("/industry-pairings");
  revalidatePath("/leads");
  revalidatePath("/");
}

/**
 * Scrape a list of supplier websites into the pair database.
 *
 * Deliberately takes domains rather than a search query: without an
 * ANTHROPIC_API_KEY there is no search step, and a scraper that invents its own
 * targets is how you end up crawling the wrong half of the internet. Paste a
 * list, or let the search-backed discovery fill it once a key is set.
 */
export async function scrapeSuppliers(businessId: string, pairingId: string, formData: FormData) {
  const raw = String(formData.get("domains") ?? "");
  const domains = raw
    .split(/[\s,;\n]+/)
    .map((d) => d.trim())
    .filter(Boolean)
    .slice(0, 40);

  if (!domains.length) return;
  await ingestMany(businessId, domains, { pairingId, asSupplierLead: true });
  refresh();
}

export async function draftRecruitmentEmail(businessId: string, leadId: string) {
  await runSupplierRecruiter(businessId, leadId);
  revalidatePath("/leads");
}

export async function setLeadStatus(
  leadId: string,
  status: "IDENTIFIED" | "ENRICHED" | "CONTACTED" | "INTERESTED" | "ONBOARDED" | "DECLINED" | "UNREACHABLE",
) {
  await db.supplierLead.update({ where: { id: leadId }, data: { status } });
  refresh();
}

/** Promote an interested lead into a real Supplier we can broker for. */
export async function onboardSupplier(businessId: string, leadId: string) {
  const lead = await db.supplierLead.findUniqueOrThrow({
    where: { id: leadId },
    include: { company: true, pairing: true },
  });

  const existing = await db.supplier.findFirst({ where: { businessId, companyId: lead.companyId } });
  if (!existing) {
    await db.supplier.create({
      data: {
        businessId,
        companyId: lead.companyId,
        name: lead.company.name,
        isSelf: false,
        websiteUrl: lead.company.websiteUrl,
        contactEmail: lead.bestEmail,
        notes: lead.whatTheySell,
        defaultCommissionModel: "PERCENT",
        defaultCommissionRate: lead.pairing?.commissionRate ?? 15,
      },
    });
  }
  await db.supplierLead.update({ where: { id: leadId }, data: { status: "ONBOARDED" } });
  revalidatePath("/leads");
  revalidatePath("/suppliers");
}

export async function setPairingStatus(pairingId: string, status: "proposed" | "active" | "parked") {
  await db.pairing.update({ where: { id: pairingId }, data: { status } });
  refresh();
}

/** Generate new pairings for one supplier sector. */
export async function scoutSector(businessId: string, sector: string) {
  const { runPairingScout } = await import("@/agents/pairing-scout");
  await runPairingScout(businessId, sector, 8);
  refresh();
}

/**
 * Sweep every supplier sector. This is the volume lever — 30 sectors x 8
 * pairings is ~240 theses, far past what anyone would write by hand. Runs
 * sequentially; expect several minutes and a real API bill.
 */
export async function sweepSectors(businessId: string) {
  const { sweepAllSectors } = await import("@/agents/pairing-scout");
  await sweepAllSectors(businessId, 8);
  refresh();
}

/**
 * Find and scrape targets for a pairing with no input. Side A recruits
 * suppliers; side B finds buyers.
 */
export async function autoDiscover(businessId: string, pairingId: string, side: "A" | "B") {
  const { discoverForPairing } = await import("@/scraper/discover");
  await discoverForPairing(businessId, pairingId, { limit: 25, side });
  refresh();
}
