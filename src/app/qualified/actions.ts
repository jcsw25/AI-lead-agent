"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { qualifyAll } from "@/lib/scoring/qualify";

/**
 * Re-score and re-qualify every company.
 *
 * Deterministic and free — no model call, no network — so this is safe to run
 * whenever evidence changes or the weights are edited. Roughly a second for a
 * few hundred companies.
 */
export async function runQualification(businessId: string, formData: FormData) {
  const industry = String(formData.get("industry") ?? "").trim() || undefined;
  await qualifyAll(businessId, { industry });

  revalidatePath("/qualified");
  revalidatePath("/prospects");
  revalidatePath("/");
}

/** Override the machine's verdict. A human decision outranks the arithmetic. */
export async function overrideQualification(businessId: string, formData: FormData) {
  const companyId = String(formData.get("companyId") ?? "");
  const to = String(formData.get("to") ?? "");
  if (!companyId || !["QUALIFIED", "REJECTED"].includes(to)) return;

  const q = await db.qualification.findUnique({
    where: { businessId_companyId: { businessId, companyId } },
  });
  if (!q) return;

  await db.qualification.update({
    where: { id: q.id },
    data: {
      status: to as "QUALIFIED" | "REJECTED",
      rejectionReason: to === "REJECTED" ? "MANUAL" : null,
      explanation: `${q.explanation}\n\nOverridden by hand to ${to}.`,
    },
  });

  if (to === "QUALIFIED") {
    await db.prospect.upsert({
      where: { businessId_companyId: { businessId, companyId } },
      create: {
        businessId, companyId, stage: "QUALIFIED",
        tier: q.score >= 80 ? "HOT" : q.score >= 50 ? "WARM" : "COLD",
        score: q.score, scoreVersion: q.modelVersion, source: "manual",
      },
      update: { stage: "QUALIFIED" },
    });
  } else {
    // Keep the prospect row — it may already have history — but mark it out.
    await db.prospect.updateMany({
      where: { businessId, companyId },
      data: { stage: "DISQUALIFIED", disqualifiedReason: "Rejected by hand" },
    });
  }

  revalidatePath("/qualified");
  revalidatePath("/prospects");
}
