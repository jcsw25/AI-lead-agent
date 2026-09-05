import { db } from "@/lib/db";
import { runAgent } from "@/agents/runtime";
import { acquisitionEnquiry } from "@/agents/acquisition-enquiry";
import { checkDraft, checkInventedNames, checkPlaceholders, violationBrief, type Violation } from "@/lib/outreach/quality";
import { checkAcquisitionEnquiry } from "@/lib/outreach/quality-acquisition";

/**
 * Drafting the approach to an owner.
 *
 * Everything goes into the same approval queue as the rest of the outreach and
 * through the same compliance gate on send. An acquisition enquiry is still
 * unsolicited commercial email under the Spam Control Act — the subject matter
 * being a company rather than a service changes nothing about the sender
 * identity, the unsubscribe facility, or the bulk thresholds.
 */

export type EnquiryDraftResult = {
  drafted: number;
  skipped: Array<{ target: string; why: string }>;
  costUsd: number;
};

/** Only figures the listing itself published. Our own estimates never appear. */
function statedFacts(t: {
  askingPrice: unknown;
  revenue: unknown;
  currency: string;
  yearsEstablished: number | null;
  employeeCount: number | null;
  sellerReason: string | null;
}): string[] {
  const money = (v: unknown) => (v == null ? null : `${t.currency} ${Number(v).toLocaleString()}`);
  return [
    money(t.askingPrice) && `Asking price as advertised: ${money(t.askingPrice)}`,
    money(t.revenue) && `Revenue as advertised: ${money(t.revenue)}`,
    t.yearsEstablished && `Advertised as established ${t.yearsEstablished}`,
    t.employeeCount && `Advertised staff count: ${t.employeeCount}`,
    t.sellerReason && `Stated reason for selling: ${t.sellerReason}`,
  ].filter(Boolean) as string[];
}

/**
 * Which rung to ask for.
 *
 * Derived from the status rather than chosen, so an owner who has said nothing
 * can never be asked for their P&L. The checker enforces the same thing
 * independently — this decides it, that one proves it.
 */
function askFor(status: string): "OPEN_TO_SELLING" | "NDA" | "FINANCIALS" | null {
  if (status === "IDENTIFIED") return "OPEN_TO_SELLING";
  if (status === "INTERESTED") return "NDA";
  if (status === "NDA_SIGNED") return "FINANCIALS";
  return null;
}

export async function draftEnquiryFor(
  businessId: string,
  targetId: string,
): Promise<{ messageId: string; costUsd: number; violations: Violation[] } | { skipped: string }> {
  const target = await db.acquisitionTarget.findFirstOrThrow({
    where: { id: targetId, businessId },
    include: { company: { include: { contacts: true } } },
  });

  const ask = askFor(target.status);
  if (!ask) return { skipped: `nothing to ask at ${target.status.toLowerCase()}` };

  // A listing with no company behind it is reached through the marketplace's
  // own enquiry form, by a person. There is no address to send to, and
  // inventing one is not an option.
  const contact = target.company?.contacts.find((c) => c.email && !c.email.startsWith("unknown-"));
  if (!contact?.email) {
    return {
      skipped: target.origin === "LISTED"
        ? "anonymised listing — enquire through the marketplace by hand"
        : "no sendable email address",
    };
  }

  // One live message per company, whatever its source. An acquisition enquiry
  // landing on top of an unanswered service pitch to the same person is how a
  // real approach gets binned as a mailing list.
  const existing = await db.message.findFirst({
    where: {
      businessId,
      contact: { companyId: target.companyId ?? "none" },
      direction: "OUTBOUND",
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
    select: { status: true },
  });
  if (existing) return { skipped: `already has a ${existing.status.toLowerCase()} message` };

  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { sendPolicy: true },
  });
  const isRole = !contact.jobTitle || contact.jobTitle === "General enquiries";
  const facts = target.origin === "LISTED" ? statedFacts(target) : [];

  const input = {
    senderName: business.sendPolicy?.senderName ?? business.name,
    senderBusiness: business.name,
    targetName: target.company?.name ?? target.name,
    industry: target.industry ?? "",
    contactName: isRole ? undefined : (contact.fullName ?? undefined),
    isRoleInbox: isRole,
    origin: target.origin,
    listingSource: target.listingSource ?? undefined,
    statedFacts: facts,
    ask,
  };

  const allowedNames = [target.name, target.company?.name, business.name, target.listingSource].filter(
    Boolean,
  ) as string[];

  const inspect = (subject: string, body: string): Violation[] => [
    ...checkDraft(subject, body, { minWords: 40 }),
    ...checkAcquisitionEnquiry(subject, body, { ask, origin: target.origin, statedFacts: facts }),
    ...checkInventedNames(body, allowedNames),
    ...checkPlaceholders(body, subject),
  ];

  let run = await runAgent(acquisitionEnquiry, input, { businessId });
  let costUsd = run.costUsd;
  let violations = inspect(run.output.subject, run.output.body);

  if (violations.length) {
    const retry = await runAgent(
      acquisitionEnquiry,
      { ...input, statedFacts: [...facts, `REWRITE. The previous attempt broke these rules:\n${violationBrief(violations)}`] },
      { businessId },
    );
    costUsd += retry.costUsd;
    const rv = inspect(retry.output.subject, retry.output.body);
    if (rv.length < violations.length) {
      run = retry;
      violations = rv;
    }
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
      gateDecision: {
        side: "ACQUISITION",
        targetId: target.id,
        ask,
        origin: target.origin,
        question: run.output.theQuestion,
        ...(violations.length ? { toneViolations: violations } : {}),
      } as object,
    },
  });

  await db.acquisitionTarget.update({
    where: { id: target.id },
    data: { enquiryMessageId: message.id },
  });

  return { messageId: message.id, costUsd, violations };
}

/** Draft approaches for the best targets that have no message yet. */
export async function draftEnquiries(
  businessId: string,
  opts: { limit?: number; origin?: "LISTED" | "PROPRIETARY" } = {},
): Promise<EnquiryDraftResult> {
  const targets = await db.acquisitionTarget.findMany({
    where: {
      businessId,
      status: { in: ["IDENTIFIED", "INTERESTED", "NDA_SIGNED"] },
      enquiryMessageId: null,
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: (opts.limit ?? 5) * 3,
    select: { id: true, name: true },
  });

  const out: EnquiryDraftResult = { drafted: 0, skipped: [], costUsd: 0 };
  for (const t of targets) {
    if (out.drafted >= (opts.limit ?? 5)) break;
    try {
      const r = await draftEnquiryFor(businessId, t.id);
      if ("skipped" in r) out.skipped.push({ target: t.name, why: r.skipped });
      else {
        out.drafted++;
        out.costUsd += r.costUsd;
      }
    } catch (e) {
      out.skipped.push({ target: t.name, why: e instanceof Error ? e.message.slice(0, 110) : "failed" });
    }
  }
  return out;
}

/**
 * Mark a target as approached once its enquiry actually sends.
 *
 * Called from the send path, like markProbed: a draft nobody sent has asked
 * nobody anything, and counting it would inflate the denominator of the only
 * number this lane is judged on.
 */
export async function markApproached(messageId: string) {
  const target = await db.acquisitionTarget.findFirst({
    where: { enquiryMessageId: messageId },
    select: { id: true, status: true },
  });
  if (!target || target.status !== "IDENTIFIED") return;
  await db.acquisitionTarget.update({
    where: { id: target.id },
    data: { status: "APPROACHED", approachedAt: new Date() },
  });
}
