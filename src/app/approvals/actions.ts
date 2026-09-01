"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { draftSideA } from "@/lib/outreach/draft";
import { sendThroughGate } from "@/lib/gate";

function refresh() {
  revalidatePath("/approvals");
  revalidatePath("/introductions");
  revalidatePath("/outreach");
  revalidatePath("/");
}

/** Write recruitment drafts for the best suppliers without one. */
export async function draftMore(businessId: string, formData: FormData) {
  const limit = Math.min(Number(formData.get("limit") ?? 5), 25);
  const industry = String(formData.get("industry") ?? "").trim() || undefined;
  await draftSideA(businessId, { limit, industry });
  refresh();
}

/** Save an edited draft. A human edit outranks whatever the model wrote. */
export async function saveDraft(businessId: string, formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const subject = String(formData.get("subject") ?? "").trim();
  const bodyText = String(formData.get("bodyText") ?? "").trim();
  if (!id || !subject || !bodyText) return;

  await db.message.updateMany({
    where: { id, businessId, status: { in: ["DRAFT", "PENDING_APPROVAL", "BLOCKED_BY_GATE"] } },
    data: { subject, bodyText, status: "DRAFT", blockedReason: null },
  });
  refresh();
}

/**
 * Approve one draft and put it through the send gate.
 *
 * Approval and sending are one action on purpose. A separate "approved but not
 * sent" state invites a batch to be approved in bulk and sent without anyone
 * reading it — which is the failure mode the queue exists to prevent.
 */
export async function approveAndSend(businessId: string, formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const msg = await db.message.findFirst({ where: { id, businessId }, select: { id: true } });
  if (!msg) return;

  try {
    const decision = await sendThroughGate(id);
    if (!decision.allowed) {
      await db.message.update({
        where: { id },
        data: { status: "BLOCKED_BY_GATE", blockedReason: decision.reasons.at(-1) ?? "blocked" },
      });
    }
  } catch (e) {
    await db.message.update({
      where: { id },
      data: { status: "FAILED", blockedReason: e instanceof Error ? e.message.slice(0, 300) : "send failed" },
    });
  }
  refresh();
}

export async function discardDraft(businessId: string, formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await db.message.updateMany({ where: { id, businessId }, data: { status: "CANCELLED" } });
  // Free the introductions so a different angle can be drafted later.
  await db.introduction.updateMany({ where: { businessId, outreachMessageId: id }, data: { outreachMessageId: null } });
  refresh();
}

/** Throw the draft away and write a new one. */
export async function regenerate(businessId: string, formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const msg = await db.message.findFirst({
    where: { id, businessId },
    select: { contact: { select: { companyId: true } } },
  });
  const companyId = msg?.contact?.companyId;

  await db.message.updateMany({ where: { id, businessId }, data: { status: "CANCELLED" } });
  await db.introduction.updateMany({ where: { businessId, outreachMessageId: id }, data: { outreachMessageId: null } });

  if (companyId) {
    const { draftForSupplier } = await import("@/lib/outreach/draft");
    await draftForSupplier(businessId, companyId);
  }
  refresh();
}
