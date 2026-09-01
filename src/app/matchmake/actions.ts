"use server";

import { revalidatePath } from "next/cache";
import type { MatchmakeStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { runMatchmakerScout } from "@/agents/matchmaker-scout";

export async function findMatches(businessId: string) {
  await runMatchmakerScout(businessId, { sampleSize: 40 });
  revalidatePath("/matchmake");
}

export async function setMatchStatus(businessId: string, formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as MatchmakeStatus;
  if (!id || !status) return;
  await db.matchmake.updateMany({ where: { id, businessId }, data: { status } });
  revalidatePath("/matchmake");
}
