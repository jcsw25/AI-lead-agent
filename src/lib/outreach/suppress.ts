import { db } from "@/lib/db";
import { hashValue } from "@/lib/gate";

/**
 * Adding somebody to the suppression list.
 *
 * Pulled out of the reply poller because a second caller appeared: the need
 * extractor catches politely-worded requests to stop that the pattern list does
 * not. Two copies of this would eventually differ, and the copy that drifted
 * would be the one that quietly stopped suppressing anybody.
 *
 * The hash is the gate's salted one, not a plain digest. The gate looks
 * suppression up by hashValue(), so an unsalted hash here would never match —
 * and the entry would stop working at exactly the moment the plaintext email is
 * deleted for right-to-erasure, which is when it has to keep working.
 */
export async function suppressContact(businessId: string, rawEmail: string, note: string) {
  const email = rawEmail.trim().toLowerCase();
  const emailHash = hashValue(email);

  const already = await db.suppressionEntry.findFirst({
    where: { businessId, emailHash },
    select: { id: true },
  });
  if (!already) {
    await db.suppressionEntry.create({
      data: { businessId, scope: "BUSINESS", reason: "UNSUBSCRIBE", email, emailHash, note },
    });
  }

  const contact = await db.contact.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { companyId: true },
  });
  if (contact) {
    await db.prospect.updateMany({
      where: { businessId, companyId: contact.companyId },
      data: { stage: "SUPPRESSED", disqualifiedReason: "Asked to be removed" },
    });
  }

  return { alreadySuppressed: Boolean(already) };
}
