"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { runIndustryScout } from "@/agents/industry-scout";

export async function scoutIndustries(businessId: string) {
  await runIndustryScout(businessId);
  revalidatePath("/industries");
  revalidatePath("/");
}

export async function setPlayStatus(playId: string, status: "accepted" | "rejected" | "parked" | "proposed") {
  await db.industryPlay.update({ where: { id: playId }, data: { status } });
  revalidatePath("/industries");
  revalidatePath("/");
}

export async function clearPlays(businessId: string) {
  await db.industryPlay.deleteMany({ where: { businessId } });
  revalidatePath("/industries");
  revalidatePath("/");
}
