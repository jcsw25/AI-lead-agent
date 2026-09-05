"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";

/**
 * Work a company to the front of a queue, from the Leaks list.
 *
 * The two queues are separate actions because they are separate jobs. A leak
 * you want to hear somebody describe on the phone is not always one you want to
 * name in writing — "there are fifteen prices on your page" is a fine thing to
 * ask about in conversation and a sharper thing to put in an email.
 *
 * Pinning is a timestamp, so the most recent decision sits at the top and the
 * record of when you decided it survives.
 */
export async function pinForCall(companyId: string, on: boolean) {
  await db.company.update({
    where: { id: companyId },
    data: { pinnedForCallAt: on ? new Date() : null },
  });
  revalidatePath("/leaks-view");
  revalidatePath("/calls");
}

export async function pinForEmail(companyId: string, on: boolean) {
  await db.company.update({
    where: { id: companyId },
    data: { pinnedForEmailAt: on ? new Date() : null },
  });
  revalidatePath("/leaks-view");
  revalidatePath("/approvals");
}
