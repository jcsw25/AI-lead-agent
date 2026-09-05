"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { scrapeListings } from "@/lib/acquisition/listings";
import { seedProprietaryTargets } from "@/lib/acquisition/targets";
import { draftEnquiries } from "@/lib/acquisition/enquiry";

/** Read the marketplaces for anything newly advertised. */
export async function collectListings(businessId: string, formData: FormData) {
  const industry = String(formData.get("industry") ?? "").trim();
  try {
    await scrapeListings(businessId, {
      perSource: 25,
      industry: industry || undefined,
    });
  } catch (e) {
    console.error("[acquisitions]", e instanceof Error ? e.message : e);
  }
  revalidatePath("/acquisitions");
}

/** Turn companies we already hold into targets nobody else is looking at. */
export async function seedProprietary(businessId: string, formData: FormData) {
  const industry = String(formData.get("industry") ?? "").trim();
  if (!industry) return;
  try {
    await seedProprietaryTargets(businessId, industry, { limit: 40 });
  } catch (e) {
    console.error("[acquisitions]", e instanceof Error ? e.message : e);
  }
  revalidatePath("/acquisitions");
}

/** Draft approaches. They land in Approvals like everything else. */
export async function draftApproaches(businessId: string, formData: FormData) {
  const origin = String(formData.get("origin") ?? "") as "LISTED" | "PROPRIETARY" | "";
  try {
    await draftEnquiries(businessId, { limit: 5, origin: origin || undefined });
  } catch (e) {
    console.error("[acquisitions]", e instanceof Error ? e.message : e);
  }
  revalidatePath("/acquisitions");
  revalidatePath("/approvals");
}

/**
 * Move a target along the ladder by hand.
 *
 * NDAs are signed in email and PDFs arrive as attachments — none of that is
 * visible to this system, so a human moves the rung. The one status not settable
 * here is INTERESTED, which is set by reading a reply, so that "they said they
 * would consider it" always has a message behind it.
 */
export async function setStatus(businessId: string, formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const allowed = ["NDA_SIGNED", "FINANCIALS", "LOI", "DEAD", "IDENTIFIED"];
  if (!id || !allowed.includes(status)) return;
  await db.acquisitionTarget.updateMany({
    where: { id, businessId },
    data: { status: status as never },
  });
  revalidatePath("/acquisitions");
}
