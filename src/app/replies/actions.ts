"use server";

import { revalidatePath } from "next/cache";
import { pollReplies } from "@/lib/outreach/replies";

/** Pull new replies from the connected mailbox. */
export async function checkForReplies(businessId: string) {
  try {
    await pollReplies(businessId);
  } catch (e) {
    // A mailbox that is not connected must not throw a page error — the page
    // already explains the state.
    console.error("[replies]", e instanceof Error ? e.message : e);
  }
  revalidatePath("/replies");
  revalidatePath("/approvals");
  revalidatePath("/settings");
}
