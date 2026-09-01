"use server";

import { revalidatePath } from "next/cache";
import type { LeadTier, MatchStatus, ProspectStage, ReplyClass } from "@prisma/client";
import { db } from "@/lib/db";
import { runProspectHunter } from "@/agents/prospect-hunter";
import { runMatchmaker } from "@/agents/matchmaker";
import { runOutreachWriter } from "@/agents/outreach";

function refresh(prospectId?: string) {
  revalidatePath("/prospects");
  revalidatePath("/industries");
  revalidatePath("/");
  if (prospectId) revalidatePath(`/prospects/${prospectId}`);
}

/** Industry play -> real companies + contacts. */
export async function findCompanies(businessId: string, playId: string) {
  await db.industryPlay.update({ where: { id: playId }, data: { status: "accepted" } });
  await runProspectHunter(businessId, playId, 8);
  refresh();
}

/** Buyer -> best product to pitch, with commission terms. */
export async function matchProspect(businessId: string, prospectId: string) {
  await runMatchmaker(businessId, prospectId);
  refresh(prospectId);
}

/** Match -> cold email draft, pending approval. */
export async function draftOutreach(businessId: string, matchId: string, prospectId: string) {
  await runOutreachWriter(businessId, matchId);
  refresh(prospectId);
}

/** Run the whole chain for every un-matched prospect on a play. */
export async function matchAllForPlay(businessId: string, playId: string) {
  const prospects = await db.prospect.findMany({
    where: { businessId, playId, matches: { none: {} } },
    select: { id: true },
    take: 25,
  });
  for (const p of prospects) await runMatchmaker(businessId, p.id);
  refresh();
}

/**
 * Approving a draft marks it sent. Real sending goes through the compliance
 * send gate in Phase 2.5 — this records the state transition only.
 */
export async function approveAndSend(messageId: string, prospectId: string) {
  const msg = await db.message.update({
    where: { id: messageId },
    data: { status: "SENT", sentAt: new Date() },
  });
  await db.prospect.update({
    where: { id: prospectId },
    data: { stage: "CONTACTED", firstContactedAt: new Date(), lastActivityAt: new Date() },
  });
  if (msg.matchId) await db.match.update({ where: { id: msg.matchId }, data: { status: "PITCHED" } });
  await db.activity.create({
    data: { prospectId, type: "email_sent", summary: `Outreach approved and sent: "${msg.subject}"`, actorType: "user" },
  });
  refresh(prospectId);
}

/** Manual pipeline moves — the operator always outranks the classifier. */
export async function setTier(prospectId: string, tier: LeadTier) {
  const stage: ProspectStage = tier === "HOT" ? "OPPORTUNITY" : tier === "WARM" ? "ENGAGED" : "CONTACTED";
  await db.prospect.update({ where: { id: prospectId }, data: { tier, stage, lastActivityAt: new Date() } });
  await db.activity.create({
    data: { prospectId, type: "classified", summary: `Marked ${tier} by user`, actorType: "user" },
  });
  refresh(prospectId);
}

export async function setStage(prospectId: string, stage: ProspectStage) {
  await db.prospect.update({ where: { id: prospectId }, data: { stage, lastActivityAt: new Date() } });
  await db.activity.create({ data: { prospectId, type: "stage", summary: `Moved to ${stage}`, actorType: "user" } });
  refresh(prospectId);
}

export async function setMatchStatus(matchId: string, status: MatchStatus, prospectId: string) {
  await db.match.update({
    where: { id: matchId },
    data: {
      status,
      introducedAt: status === "INTRODUCED" ? new Date() : undefined,
      closedAt: status === "WON" || status === "LOST" ? new Date() : undefined,
    },
  });
  await db.activity.create({
    data: { prospectId, type: "match_status", summary: `Introduction marked ${status}`, actorType: "user" },
  });
  refresh(prospectId);
}

/**
 * Records an inbound reply and classifies it. Until the inbox is wired up
 * (Phase 3) this is how you exercise the pipeline — it writes a real inbound
 * Message and moves the prospect, same as a live reply would.
 */
export async function logReply(prospectId: string, replyClass: ReplyClass, text: string) {
  const prospect = await db.prospect.findUniqueOrThrow({
    where: { id: prospectId },
    include: { contacts: { include: { contact: true }, orderBy: { isPrimary: "desc" } }, matches: true },
  });

  await db.message.create({
    data: {
      businessId: prospect.businessId,
      contactId: prospect.contacts[0]?.contactId,
      matchId: prospect.matches[0]?.id,
      channel: "EMAIL",
      direction: "INBOUND",
      status: "DELIVERED",
      subject: "Re: outreach",
      bodyText: text,
      replyClass,
      repliedAt: new Date(),
    },
  });

  const map: Record<string, { tier?: LeadTier; stage: ProspectStage }> = {
    HOT: { tier: "HOT", stage: "OPPORTUNITY" },
    WARM: { tier: "WARM", stage: "ENGAGED" },
    COLD: { tier: "COLD", stage: "ENGAGED" },
    NEGATIVE: { tier: "COLD", stage: "LOST" },
    UNSUBSCRIBE: { stage: "SUPPRESSED" },
    WRONG_CONTACT: { stage: "RESEARCHING" },
    OUT_OF_OFFICE: { stage: "CONTACTED" },
    UNSURE: { stage: "ENGAGED" },
    AUTO_REPLY: { stage: "CONTACTED" },
    BOUNCE: { stage: "DISQUALIFIED" },
  };
  const next = map[replyClass] ?? { stage: "ENGAGED" as ProspectStage };

  await db.prospect.update({
    where: { id: prospectId },
    data: { tier: next.tier, stage: next.stage, lastActivityAt: new Date() },
  });

  if (replyClass === "UNSUBSCRIBE") {
    const email = prospect.contacts[0]?.contact.email;
    if (email) {
      await db.suppressionEntry.create({
        data: { businessId: prospect.businessId, scope: "BUSINESS", reason: "UNSUBSCRIBE", email },
      });
    }
  }
  if (replyClass === "HOT" && prospect.matches[0]) {
    await db.match.update({ where: { id: prospect.matches[0].id }, data: { status: "INTERESTED" } });
  }

  await db.activity.create({
    data: { prospectId, type: "replied", summary: `Reply received — classified ${replyClass}` },
  });
  refresh(prospectId);
}

export async function deleteProspect(prospectId: string) {
  await db.prospect.delete({ where: { id: prospectId } });
  refresh();
}

/**
 * Log a discovery call. This is the step that turns a service lead into a
 * scoped deal — the problems captured here are the only ones the solution
 * designer is allowed to build a proposal around.
 */
export async function logDiscoveryCall(
  businessId: string,
  prospectId: string,
  matchId: string | null,
  formData: FormData,
) {
  const lines = (v: FormDataEntryValue | null) =>
    String(v ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

  const call = await db.discoveryCall.create({
    data: {
      businessId,
      prospectId,
      matchId,
      heldAt: new Date(),
      attendees: lines(formData.get("attendees")),
      notes: String(formData.get("notes") ?? "").trim(),
      problemsIdentified: lines(formData.get("problems")).map((p) => ({ problem: p, severity: "unknown" })),
      systemsMentioned: lines(formData.get("systems")),
      budgetSignal: String(formData.get("budget") ?? "").trim() || null,
      timelineSignal: String(formData.get("timeline") ?? "").trim() || null,
      nextStep: String(formData.get("nextStep") ?? "").trim() || null,
    },
  });

  await db.prospect.update({
    where: { id: prospectId },
    data: { stage: "MEETING", lastActivityAt: new Date() },
  });
  await db.activity.create({
    data: {
      prospectId,
      type: "call",
      summary: `Discovery call logged — ${(call.problemsIdentified as unknown[]).length} problem(s) captured`,
      actorType: "user",
    },
  });
  refresh(prospectId);
}

/** Call notes -> scoped engagement with phases, risks and commission. */
export async function designSolution(businessId: string, callId: string, prospectId: string) {
  const { runSolutionDesigner } = await import("@/agents/solution-designer");
  await runSolutionDesigner(businessId, callId);
  refresh(prospectId);
}

export async function setProposalStatus(
  proposalId: string,
  status: "draft" | "sent" | "accepted" | "rejected",
  prospectId: string,
) {
  await db.solutionProposal.update({ where: { id: proposalId }, data: { status } });
  if (status === "accepted") {
    const p = await db.solutionProposal.findUniqueOrThrow({ where: { id: proposalId } });
    if (p.matchId) await db.match.update({ where: { id: p.matchId }, data: { status: "WON", closedAt: new Date() } });
    await db.prospect.update({ where: { id: prospectId }, data: { stage: "WON" } });
  }
  await db.activity.create({
    data: { prospectId, type: "proposal_status", summary: `Proposal marked ${status}`, actorType: "user" },
  });
  refresh(prospectId);
}
