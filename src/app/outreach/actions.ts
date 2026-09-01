"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { runOutreachWriter } from "@/agents/outreach";
import { sendThroughGate } from "@/lib/gate";

function refresh() {
  revalidatePath("/outreach");
  revalidatePath("/prospects");
  revalidatePath("/");
}

/**
 * Draft for every matched prospect that has no draft yet. Each email is written
 * per-company from that company's own match, trigger and contact - which is
 * both why it converts and why the batch does not collapse into one "same
 * subject matter" bucket under the Spam Control Act.
 */
export async function draftBatch(businessId: string, limit: number): Promise<void> {
  const matches = await db.match.findMany({
    where: {
      businessId,
      status: { in: ["PROPOSED", "APPROVED"] },
      prospect: { stage: { notIn: ["SUPPRESSED", "LOST", "DISQUALIFIED", "WON"] }, contacts: { some: {} } },
      messages: { none: { direction: "OUTBOUND" } },
    },
    orderBy: { fitScore: "desc" },
    take: limit,
    select: { id: true },
  });

  for (const m of matches) {
    try {
      await runOutreachWriter(businessId, m.id);
    } catch (e) {
      // One bad prospect must not abort the batch. The failure is already
      // recorded as a FAILED AgentRun, visible on /runs.
      console.error(`draft failed for match ${m.id}:`, e instanceof Error ? e.message : e);
    }
  }
  refresh();
}

/**
 * Push approved drafts through the send gate, one at a time. Sequential on
 * purpose: the bulk-threshold counter reads the ledger, so concurrent sends
 * would race past the limit before any of them recorded.
 */
export async function sendBatch(messageIds: string[]) {
  const results = { sent: 0, blocked: 0, failed: 0, reasons: [] as string[] };
  for (const id of messageIds) {
    try {
      const d = await sendThroughGate(id);
      if (d.allowed) results.sent++;
      else {
        results.blocked++;
        if (results.reasons.length < 4) results.reasons.push(d.reasons[d.reasons.length - 1]);
      }
    } catch (e) {
      results.failed++;
      if (results.reasons.length < 4) results.reasons.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Move the prospects the sends belong to.
  const sent = await db.message.findMany({
    where: { id: { in: messageIds }, status: "SENT" },
    select: { matchId: true },
  });
  const matchIds = sent.map((m) => m.matchId).filter((x): x is string => Boolean(x));
  if (matchIds.length) {
    await db.match.updateMany({ where: { id: { in: matchIds } }, data: { status: "PITCHED" } });
    const ms = await db.match.findMany({ where: { id: { in: matchIds } }, select: { prospectId: true } });
    await db.prospect.updateMany({
      where: { id: { in: ms.map((m) => m.prospectId) } },
      data: { stage: "CONTACTED", firstContactedAt: new Date(), lastActivityAt: new Date() },
    });
  }

  refresh();
  return results;
}

export async function sendAllApproved(businessId: string): Promise<void> {
  const drafts = await db.message.findMany({
    where: { businessId, direction: "OUTBOUND", status: "PENDING_APPROVAL" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  await sendBatch(drafts.map((d) => d.id));
}

export async function discardDraft(messageId: string) {
  await db.message.update({ where: { id: messageId }, data: { status: "CANCELLED" } });
  refresh();
}

export async function retryBlocked(messageId: string) {
  await db.message.update({
    where: { id: messageId },
    data: { status: "PENDING_APPROVAL", blockedReason: null },
  });
  refresh();
}
