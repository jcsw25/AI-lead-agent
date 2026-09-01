"use server";

import { revalidatePath } from "next/cache";

/** Re-run every probe. The page runs them on load, so this just busts the cache. */
export async function recheck() {
  revalidatePath("/admin");
}
