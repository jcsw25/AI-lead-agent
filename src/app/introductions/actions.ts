"use server";

import { revalidatePath } from "next/cache";
import type { IntroductionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { buildIntroductions } from "@/lib/matching/introduce";
import { generatePairingsForDatabase } from "@/agents/pairing-generator";
import { onboardSupplier } from "@/lib/outreach/onboard";
import { draftSideB } from "@/lib/outreach/draft-buyer";

function refresh() {
  revalidatePath("/introductions");
  revalidatePath("/industry-pairings");
  revalidatePath("/");
}

/** Recompute company-level matches. Deterministic and free — no model call. */
export async function rematch(businessId: string) {
  await buildIntroductions(businessId);
  refresh();
}

/** Ask for new A→B theses covering the industries currently in the database. */
export async function generatePairings(businessId: string) {
  await generatePairingsForDatabase(businessId);
  await buildIntroductions(businessId);
  refresh();
}

export async function setIntroductionStatus(businessId: string, formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as IntroductionStatus;
  if (!id || !status) return;

  // "A agreed" is not just a status change — it is the moment a scraped company
  // becomes a real partner. It creates the Supplier and SupplierProduct rows
  // that make the buyer-side email honest, and promotes the introduction to a
  // Match. Doing it here means the transition cannot be recorded without the
  // records that justify it existing.
  if (status === "A_AGREED") {
    const intro = await db.introduction.findFirst({
      where: { id, businessId },
      select: { companyAId: true },
    });
    if (intro) {
      try {
        await onboardSupplier(businessId, intro.companyAId);
      } catch (e) {
        console.error("[onboard] failed:", e instanceof Error ? e.message : e);
      }
    }
    refresh();
    return;
  }

  await db.introduction.updateMany({
    where: { id, businessId },
    data: {
      status,
      ...(status === "INTRODUCED" ? { introducedAt: new Date() } : {}),
      ...(status === "WON" || status === "LOST" ? { closedAt: new Date() } : {}),
    },
  });
  refresh();
}


/** Write the buyer-side email. Refuses unless the supplier has actually agreed. */
export async function draftBuyerEmail(businessId: string, formData: FormData) {
  const companyAId = String(formData.get("companyAId") ?? "");
  const limit = Math.min(Number(formData.get("limit") ?? 3), 10);
  if (!companyAId) return;
  await draftSideB(businessId, { limit, companyAId });
  refresh();
  revalidatePath("/approvals");
}
