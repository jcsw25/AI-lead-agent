import { db } from "@/lib/db";
import { runAgent } from "@/agents/runtime";
import { demandProbe } from "@/agents/demand-probe";
import { checkDraft, checkInventedNames, checkPlaceholders, violationBrief, type Violation } from "@/lib/outreach/quality";
import { checkProbe } from "@/lib/outreach/quality-probe";

/**
 * Drafting the demand probe for a suspected need.
 *
 * One probe per company, not per need. A company suspected of needing three
 * things gets one email asking about the most likely one — three emails asking
 * three questions is a campaign, and it is also how a single recipient ends up
 * receiving mail that reads as automated.
 */

export type ProbeDraftResult = {
  drafted: number;
  skipped: Array<{ company: string; why: string }>;
  costUsd: number;
};

async function facts(companyId: string): Promise<string[]> {
  const c = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { name: true, legalName: true, description: true, industry: true },
  });
  const out: string[] = [];
  if (c.description) out.push(`In their own words, from their site: "${c.description.replace(/\s+/g, " ").slice(0, 220)}"`);
  if (c.legalName && c.legalName !== c.name) out.push(`Registered name: ${c.legalName}.`);
  if (c.industry) out.push(`Trade: ${c.industry}.`);
  return out;
}

export async function draftProbeFor(
  businessId: string,
  needId: string,
): Promise<{ messageId: string; costUsd: number; violations: Violation[] } | { skipped: string }> {
  const need = await db.need.findFirstOrThrow({
    where: { id: needId, businessId },
    include: { company: { include: { contacts: true } } },
  });

  if (need.status !== "SUSPECTED") return { skipped: `already ${need.status.toLowerCase()}` };

  const contact = need.company.contacts.find((c) => c.email && !c.email.startsWith("unknown-"));
  if (!contact?.email) return { skipped: "no sendable email address" };

  // One live message per company, whatever its source. A probe landing on top
  // of an unanswered draft is how a person starts looking like a mailing list.
  const existing = await db.message.findFirst({
    where: {
      businessId,
      contact: { companyId: need.companyId },
      direction: "OUTBOUND",
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
    select: { status: true },
  });
  if (existing) return { skipped: `company already has a ${existing.status.toLowerCase()} message` };

  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { sendPolicy: true },
  });
  const isRole = !contact.jobTitle || contact.jobTitle === "General enquiries";
  const verifiedFacts = await facts(need.companyId);

  const input = {
    senderName: business.sendPolicy?.senderName ?? business.name,
    senderBusiness: business.name,
    buyerName: need.company.name,
    buyerIndustry: need.company.industry ?? "",
    contactName: isRole ? undefined : contact.fullName,
    isRoleInbox: isRole,
    category: need.category,
    verifiedFacts,
  };

  const allowedNames = [need.company.name, business.name];
  const inspect = (subject: string, body: string, question: string): Violation[] => [
    // A probe is meant to be short. The general 60-word floor is for emails
    // that have to explain an opportunity; this one has to ask a question.
    ...checkDraft(subject, body, { minWords: 30 }),
    ...checkProbe(subject, body, question, allowedNames),
    ...checkInventedNames(body, allowedNames),
    ...checkPlaceholders(body, subject),
  ];

  let run = await runAgent(demandProbe, input, { businessId });
  let costUsd = run.costUsd;
  let violations = inspect(run.output.subject, run.output.body, run.output.theQuestion);

  if (violations.length) {
    const retry = await runAgent(
      demandProbe,
      { ...input, verifiedFacts: [...verifiedFacts, `REWRITE. The previous attempt broke these rules:\n${violationBrief(violations)}`] },
      { businessId },
    );
    costUsd += retry.costUsd;
    const rv = inspect(retry.output.subject, retry.output.body, retry.output.theQuestion);
    if (rv.length < violations.length) { run = retry; violations = rv; }
  }

  const message = await db.message.create({
    data: {
      businessId,
      contactId: contact.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      status: "DRAFT",
      subject: run.output.subject,
      bodyText: run.output.body,
      agentRunId: run.runId,
      gateDecision: { side: "PROBE", needId: need.id, question: run.output.theQuestion,
        ...(violations.length ? { toneViolations: violations } : {}) } as object,
    },
  });

  await db.need.update({
    where: { id: need.id },
    data: { probeMessageId: message.id },
  });

  return { messageId: message.id, costUsd, violations };
}

/** Draft probes for the best suspected needs that have no message yet. */
export async function draftProbes(
  businessId: string,
  opts: { limit?: number; category?: string } = {},
): Promise<ProbeDraftResult> {
  const needs = await db.need.findMany({
    where: {
      businessId,
      status: "SUSPECTED",
      probeMessageId: null,
      ...(opts.category ? { category: { equals: opts.category, mode: "insensitive" } } : {}),
      company: { contacts: { some: { email: { not: null } } } },
    },
    orderBy: { confidence: "desc" },
    take: (opts.limit ?? 5) * 4,
    select: { id: true, companyId: true, company: { select: { name: true } } },
  });

  // One per company, best need first.
  const seen = new Set<string>();
  const targets: typeof needs = [];
  for (const n of needs) {
    if (seen.has(n.companyId)) continue;
    seen.add(n.companyId);
    targets.push(n);
    if (targets.length >= (opts.limit ?? 5)) break;
  }

  const out: ProbeDraftResult = { drafted: 0, skipped: [], costUsd: 0 };
  for (const t of targets) {
    try {
      const r = await draftProbeFor(businessId, t.id);
      if ("skipped" in r) out.skipped.push({ company: t.company.name, why: r.skipped });
      else { out.drafted++; out.costUsd += r.costUsd; }
    } catch (e) {
      out.skipped.push({ company: t.company.name, why: e instanceof Error ? e.message.slice(0, 110) : "failed" });
    }
  }
  return out;
}

/**
 * Mark a need as asked once its probe actually sends.
 *
 * Called from the send path rather than the draft path: a draft that never goes
 * out has not asked anybody anything, and counting it as PROBED would inflate
 * the reply-rate denominator — the one number this whole model is judged on.
 */
export async function markProbed(messageId: string) {
  const need = await db.need.findFirst({ where: { probeMessageId: messageId }, select: { id: true } });
  if (!need) return;
  await db.need.update({
    where: { id: need.id },
    data: { status: "PROBED", probedAt: new Date() },
  });
}
