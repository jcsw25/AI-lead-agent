"use server";

import { revalidatePath } from "next/cache";
import { seedSuspectedNeeds } from "@/lib/demand/needs";

export async function seedNeeds(businessId: string) {
  await seedSuspectedNeeds(businessId, { perPairing: 40 });
  revalidatePath("/needs");
}
