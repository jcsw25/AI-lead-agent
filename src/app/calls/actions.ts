"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { CALL_OUTCOMES, logCall, type CallOutcome } from "@/lib/calls/queue";
import { syncCallsTab } from "@/lib/calls/sheet";

/**
 * Log one call.
 *
 * Deliberately does NOT revalidate. The call station holds the queue in the
 * browser and advances on its own, and revalidating here would refetch the
 * queue mid-session and reorder it under the person using it — the row they
 * were about to dial would move. The page refreshes when they ask it to.
 */
export async function recordCall(
  businessId: string,
  contactId: string,
  outcome: CallOutcome,
  notes: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (!contactId || !CALL_OUTCOMES.includes(outcome)) {
    return { ok: false, error: "Unknown outcome." };
  }
  try {
    const m = await logCall(businessId, contactId, outcome, notes);
    return { ok: true, messageId: m.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save that." };
  }
}

/**
 * Change a call already logged.
 *
 * Going back to fix an outcome must not leave two records of one conversation:
 * the Calls tab is one row per company, and a second message would make the
 * sheet and the app disagree about what was said. So this updates in place.
 */
export async function updateCall(
  businessId: string,
  messageId: string,
  outcome: CallOutcome,
  notes: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!CALL_OUTCOMES.includes(outcome)) return { ok: false, error: "Unknown outcome." };

  const existing = await db.message.findFirst({
    where: { id: messageId, businessId, channel: "PHONE" },
    select: { id: true, contactId: true },
  });
  if (!existing) return { ok: false, error: "That call is no longer here." };

  await db.message.update({
    where: { id: existing.id },
    data: { outcome, bodyText: notes || null },
  });

  // Changing an outcome TO a refusal has to suppress, exactly as logging it
  // fresh would. Changing away from one deliberately does not un-suppress —
  // same reasoning as undo: if somebody was recorded as asking to be left
  // alone, that is not reversed by a correction to a neighbouring field.
  if (outcome === "Asked not to be contacted" && existing.contactId) {
    const contact = await db.contact.findUnique({
      where: { id: existing.contactId },
      select: { companyId: true },
    });
    if (contact) {
      await db.prospect.updateMany({
        where: { businessId, companyId: contact.companyId },
        data: { stage: "SUPPRESSED", disqualifiedReason: "Asked not to be contacted, by phone" },
      });
    }
  }
  return { ok: true };
}

/**
 * Take back the last one.
 *
 * One-tap logging means mis-taps, and without an undo the only remedy is
 * editing the database. A call recorded by accident against a real company also
 * removes them from the queue, so the mistake hides itself.
 *
 * Suppression is deliberately NOT undone here. If "asked not to be contacted"
 * was logged, the safe reading is that somebody said it — reversing that from a
 * stray click is the one direction with a real cost.
 */
export async function undoCall(businessId: string, messageId: string) {
  await db.message.deleteMany({ where: { id: messageId, businessId, channel: "PHONE" } });
  revalidatePath("/calls");
}

/** Two-way sync with the Calls tab: reads your edits first, then writes back. */
export async function syncCalls(businessId: string) {
  try {
    await syncCallsTab(businessId);
  } catch (e) {
    console.error("[calls/sheet]", e instanceof Error ? e.message : e);
  }
  revalidatePath("/calls");
}

/** Pull a fresh queue after a run of calls. */
export async function refreshQueue() {
  revalidatePath("/calls");
}
