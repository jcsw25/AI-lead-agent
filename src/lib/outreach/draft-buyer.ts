import { db } from "@/lib/db";
import { runAgent } from "@/agents/runtime";
import { buyerIntro } from "@/agents/buyer-intro";
import { checkDraft, checkInventedNames, checkPlaceholders, violationBrief, type Violation } from "./quality";

/**
 * Drafting the buyer-side email.
 *
 * Gated on the supplier having actually agreed. An introduction that is still
 * PROPOSED means nobody has said yes to anything, and writing "I work with
 * <supplier>" at that point is a claim about a relationship that does not
 * exist. The gate is here rather than in the UI so a script cannot bypass it.
 */

export type BuyerDraftResult = {
  drafted: number;
  skipped: Array<{ buyer: string; why: string }>;
  costUsd: number;
};

async function buyerFacts(companyId: string): Promise<{ facts: string[]; opening: string | null }> {
  const c = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: {
      description: true, industry: true, legalName: true, name: true,
      siteAudit: { select: { reachable: true, findings: true, hasContactForm: true } },
    },
  });

  const facts: string[] = [];
  if (c.description) facts.push(`In their own words, from their site: "${c.description.replace(/\s+/g, " ").slice(0, 240)}"`);
  if (c.legalName && c.legalName !== c.name) facts.push(`Registered name: ${c.legalName}.`);
  if (c.industry) facts.push(`Trade: ${c.industry}.`);

  // The strongest "why now" available for a business that announces nothing.
  const findings = (c.siteAudit?.findings as string[] | null) ?? [];
  const opening = c.siteAudit?.reachable && findings.length ? findings[0] : null;

  return { facts, opening };
}

export async function draftForBuyer(
  businessId: string,
  introductionId: string,
): Promise<{ messageId: string; costUsd: number; violations: Violation[] } | { skipped: string }> {
  const intro = await db.introduction.findFirstOrThrow({
    where: { id: introductionId, businessId },
    include: {
      pairing: true,
      companyA: { select: { id: true, name: true, industry: true, description: true } },
      companyB: { select: { id: true, name: true, industry: true, contacts: true } },
    },
  });

  // The gate. Never promise a buyer a supplier who has not agreed.
  if (intro.status !== "A_AGREED" && intro.status !== "B_CONTACTED") {
    return { skipped: `supplier has not agreed yet (status ${intro.status.toLowerCase()})` };
  }
  const supplier = await db.supplier.findFirst({
    where: { businessId, companyId: intro.companyA.id, isActive: true },
    select: { id: true, name: true, defaultCommissionRate: true },
  });
  if (!supplier) return { skipped: "supplier is not onboarded" };

  const contact = intro.companyB.contacts.find((c) => c.email && !c.email.startsWith("unknown-"));
  if (!contact?.email) return { skipped: "buyer has no sendable email address" };

  const existing = await db.message.findFirst({
    where: {
      businessId, contactId: contact.id, direction: "OUTBOUND",
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
    select: { status: true },
  });
  if (existing) return { skipped: `buyer already has a ${existing.status.toLowerCase()} message` };

  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId }, include: { sendPolicy: true },
  });
  const { facts, opening } = await buyerFacts(intro.companyB.id);
  const isRole = !contact.jobTitle || contact.jobTitle === "General enquiries";

  const input = {
    brokerName: business.sendPolicy?.senderName ?? business.name,
    brokerBusiness: business.name,
    buyerName: intro.companyB.name,
    buyerIndustry: intro.companyB.industry ?? intro.pairing.buyerIndustry,
    buyerContactName: isRole ? undefined : contact.fullName,
    buyerIsRoleInbox: isRole,
    buyerVerifiedFacts: facts,
    observedOpening: opening,
    supplierName: supplier.name,
    supplierWhatTheyDo: intro.companyA.industry ?? intro.pairing.supplierIndustry,
    supplierYearsOrDetail: intro.companyA.description
      ? intro.companyA.description.replace(/\s+/g, " ").slice(0, 160)
      : null,
    typicalDealLow: intro.pairing.typicalDealLow ? Number(intro.pairing.typicalDealLow) : null,
    typicalDealHigh: intro.pairing.typicalDealHigh ? Number(intro.pairing.typicalDealHigh) : null,
    currency: intro.currency,
  };

  // Every company this email may legitimately name. Anything else in the copy
  // was invented — see checkInventedNames.
  const allowedNames = [supplier.name, intro.companyA.name, intro.companyB.name, business.name];
  const inspect = (subject: string, body: string): Violation[] => [
    ...checkDraft(subject, body),
    ...checkInventedNames(body, allowedNames),
    ...checkPlaceholders(body, subject),
  ];

  let run = await runAgent(buyerIntro, input, { businessId });
  let costUsd = run.costUsd;
  let violations = inspect(run.output.subject, run.output.body);

  if (violations.length) {
    const retry = await runAgent(
      buyerIntro,
      { ...input, buyerVerifiedFacts: [...facts, `REWRITE. The previous attempt broke these rules:\n${violationBrief(violations)}`] },
      { businessId },
    );
    costUsd += retry.costUsd;
    const rv = inspect(retry.output.subject, retry.output.body);
    if (rv.length < violations.length) { run = retry; violations = rv; }
  }

  const message = await db.message.create({
    data: {
      businessId,
      introductionId: intro.id,
      contactId: contact.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      status: "DRAFT",
      subject: run.output.subject,
      bodyText: run.output.body,
      agentRunId: run.runId,
      gateDecision: violations.length ? ({ toneViolations: violations, side: "B" } as object) : ({ side: "B" } as object),
    },
  });

  await db.introduction.update({ where: { id: intro.id }, data: { status: "B_CONTACTED" } });

  return { messageId: message.id, costUsd, violations };
}

/** Draft buyer emails for every introduction whose supplier has agreed. */
export async function draftSideB(
  businessId: string,
  opts: { limit?: number; companyAId?: string } = {},
): Promise<BuyerDraftResult> {
  const intros = await db.introduction.findMany({
    where: {
      businessId,
      status: "A_AGREED",
      ...(opts.companyAId ? { companyAId: opts.companyAId } : {}),
    },
    orderBy: { fitScore: "desc" },
    take: opts.limit ?? 10,
    select: { id: true, companyB: { select: { name: true } } },
  });

  const out: BuyerDraftResult = { drafted: 0, skipped: [], costUsd: 0 };
  for (const i of intros) {
    try {
      const r = await draftForBuyer(businessId, i.id);
      if ("skipped" in r) out.skipped.push({ buyer: i.companyB.name, why: r.skipped });
      else { out.drafted++; out.costUsd += r.costUsd; }
    } catch (e) {
      out.skipped.push({ buyer: i.companyB.name, why: e instanceof Error ? e.message.slice(0, 120) : "failed" });
    }
  }
  return out;
}
