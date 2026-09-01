import { db } from "@/lib/db";
import { runAgent } from "@/agents/runtime";
import { supplierRecruiter } from "@/agents/supplier-recruiter";
import { checkDraft, checkInventedNames, checkPlaceholders, violationBrief, type Violation } from "./quality";

/**
 * Drafting side-A recruitment emails from introductions.
 *
 * One email per SUPPLIER, not per introduction. A supplier matched to eight
 * dental clinics does not want eight emails — they want one that says "I have
 * dental clinics and commercial cleaning contractors looking for what you do".
 * Sending per-introduction would turn 301 introductions into 301 emails to 44
 * companies, which is both useless and, at that volume, a bulk send under the
 * Spam Control Act.
 *
 * Nothing here sends. Every message is created as a DRAFT and has to pass both
 * a human and the send gate.
 */

export type DraftResult = {
  drafted: number;
  skipped: Array<{ company: string; why: string }>;
  costUsd: number;
};

/**
 * Facts we can actually stand behind about this company.
 *
 * The recruiter agent may only reference what appears here (ADR-003). Anything
 * else it would have to invent, and inventing facts about a supplier's business
 * is how a first call goes wrong.
 */
async function verifiedFactsFor(companyId: string): Promise<string[]> {
  const company = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: {
      name: true, legalName: true, description: true, addressLine: true, industry: true,
      websiteUrl: true,
      identifiers: { select: { scheme: true, value: true } },
      siteAudit: { select: { reachable: true, socialCount: true } },
    },
  });

  const facts: string[] = [];

  // The strongest observation is what they say they do, in their own words.
  // "They publish a phone number" is true and useless — nobody wants to be told
  // that, and offering it as material produced openers like "saw your address
  // at North Link Building", which reads as surveillance rather than interest.
  if (company.description) {
    const d = company.description.replace(/\s+/g, " ").trim();
    facts.push(`In their own words, from their site: "${d.slice(0, 300)}"`);

    // Pull out the services they list, which is usually the one genuinely
    // specific thing worth mentioning.
    const services = d
      .split(/\b(?:include|including|offer|offering|provide|providing|specialise in|specializing in|services?:)\b/i)
      .slice(1)
      .join(" ")
      .split(/[,.;]|\band\b/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length > 3 && x.length < 40 && !/singapore|we are|our |the /.test(x))
      .slice(0, 6);
    if (services.length >= 2) {
      facts.push(`Services listed on their own site: ${services.join(", ")}`);
    }
  }

  if (company.legalName && company.legalName !== company.name) {
    facts.push(`Their registered name is ${company.legalName}.`);
  }

  const uen = company.identifiers.find((i) => i.scheme === "UEN");
  if (uen) facts.push(`Registered in Singapore, UEN ${uen.value}.`);

  if (company.industry) facts.push(`Trade: ${company.industry}.`);

  return facts;
}

/**
 * Draft the recruitment email for one supplier, covering every introduction
 * they appear in on side A.
 */
export async function draftForSupplier(
  businessId: string,
  companyAId: string,
): Promise<{ messageId: string; costUsd: number; violations: Violation[] } | { skipped: string }> {
  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { sendPolicy: true },
  });

  const company = await db.company.findUniqueOrThrow({
    where: { id: companyAId },
    include: { contacts: { orderBy: { verification: "asc" } } },
  });

  const intros = await db.introduction.findMany({
    where: { businessId, companyAId, status: { in: ["PROPOSED", "APPROVED"] } },
    orderBy: { fitScore: "desc" },
    include: { pairing: true },
  });
  if (!intros.length) return { skipped: "no open introductions on side A" };

  const contact = company.contacts.find((c) => c.email && !c.email.startsWith("unknown-"));
  if (!contact?.email) return { skipped: "no sendable email address" };

  // Already drafted or sent? Never write a second one silently.
  //
  // CANCELLED is excluded deliberately: discarding a draft and rewriting it is
  // the whole point of the Rewrite button, and counting a cancelled message as
  // "already has one" silently made that button do nothing.
  const existing = await db.message.findFirst({
    where: {
      businessId,
      contactId: contact.id,
      direction: "OUTBOUND",
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
    select: { id: true, status: true },
  });
  if (existing) return { skipped: `already has a ${existing.status.toLowerCase()} message` };

  // The best introduction is the hook; the rest broaden the demand claim.
  const lead = intros[0];
  const buyerIndustries = [...new Set(intros.map((i) => i.pairing.buyerIndustry))];
  const buyerSummary =
    buyerIndustries.length === 1
      ? buyerIndustries[0]
      : `${buyerIndustries.slice(0, -1).join(", ")} and ${buyerIndustries.at(-1)}`;

  const facts = await verifiedFactsFor(companyAId);
  const isRole = !contact.jobTitle || contact.jobTitle === "General enquiries";

  const baseInput = {
      senderName: business.sendPolicy?.senderName ?? business.name,
      senderBusiness: business.name,
      supplierName: company.name,
      supplierWhatTheySell: company.industry ?? lead.pairing.supplierIndustry,
      contactName: isRole ? undefined : contact.fullName,
      contactRole: isRole ? undefined : (contact.jobTitle ?? undefined),
      isRoleBasedInbox: isRole,

      buyerIndustry: buyerSummary,
      whatTheyHave: lead.pairing.whatAHas,
      whatBuyersNeed: lead.pairing.whatBNeeds,
      trigger: lead.trigger ?? lead.pairing.trigger,
      timingWindow: lead.pairing.timingWindow ?? undefined,

      commissionRate: lead.commissionRate ? Number(lead.commissionRate) * 100 : null,
      typicalDealLow: lead.pairing.typicalDealLow ? Number(lead.pairing.typicalDealLow) : null,
      typicalDealHigh: lead.pairing.typicalDealHigh ? Number(lead.pairing.typicalDealHigh) : null,
      currency: lead.currency,
    // When there is nothing verified to say, say so explicitly. Left to infer
    // it, the model fills the gap with invented warmth ("your name kept coming
    // up") rather than opening generically.
    verifiedFacts: facts.length
      ? facts
      : [
          "NOTHING has been verified about this company beyond its trade and that it has a website. " +
            "Open with how you came across them and make NO claims about their business, their reputation, " +
            "or anyone having mentioned them.",
        ],
  };

  // Generate, check, and regenerate once with the failures named.
  //
  // The tone rules are in the prompt, but two rewrites of that prompt each
  // still produced copy that opened with an ask or lectured the recipient —
  // the model honours most rules and quietly drops others. Checking
  // mechanically and feeding the failures back is what actually holds the line.
  const allowedNames = [company.name, business.name];
  const inspect = (subject: string, body: string): Violation[] => [
    ...checkDraft(subject, body),
    ...checkInventedNames(body, allowedNames),
    ...checkPlaceholders(body, subject),
  ];

  let run = await runAgent(supplierRecruiter, baseInput, { businessId });
  let costUsd = run.costUsd;
  let violations = inspect(run.output.initial.subject, run.output.initial.body);

  if (violations.length) {
    const retry = await runAgent(
      supplierRecruiter,
      {
        ...baseInput,
        verifiedFacts: [
          ...facts,
          `REWRITE. The previous attempt broke these rules:
${violationBrief(violations)}`,
        ],
      },
      { businessId },
    );
    costUsd += retry.costUsd;
    const retryViolations = inspect(retry.output.initial.subject, retry.output.initial.body);
    // Keep whichever is cleaner; a retry that is worse is not an improvement.
    if (retryViolations.length < violations.length) {
      run = retry;
      violations = retryViolations;
    }
  }

  const message = await db.message.create({
    data: {
      businessId,
      introductionId: lead.id,
      contactId: contact.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      status: "DRAFT",
      subject: run.output.initial.subject,
      bodyText: run.output.initial.body,
      agentRunId: run.runId,
      // Surfaced in the queue so a draft that still breaks a rule is visible
      // rather than quietly approved.
      gateDecision: violations.length ? ({ toneViolations: violations } as object) : undefined,
    },
  });

  // Point every covered introduction at the one message.
  await db.introduction.updateMany({
    where: { id: { in: intros.map((i) => i.id) } },
    data: { outreachMessageId: message.id },
  });

  return { messageId: message.id, costUsd, violations };
}

/** Draft for the best side-A companies that do not have a message yet. */
export async function draftSideA(
  businessId: string,
  opts: { limit?: number; industry?: string } = {},
): Promise<DraftResult> {
  const limit = opts.limit ?? 10;

  const intros = await db.introduction.findMany({
    where: {
      businessId,
      status: { in: ["PROPOSED", "APPROVED"] },
      outreachMessageId: null,
      ...(opts.industry ? { companyA: { industry: { equals: opts.industry, mode: "insensitive" } } } : {}),
    },
    orderBy: { fitScore: "desc" },
    select: { companyAId: true, companyA: { select: { name: true } } },
  });

  // Distinct suppliers, best-first.
  const seen = new Set<string>();
  const targets: Array<{ id: string; name: string }> = [];
  for (const i of intros) {
    if (seen.has(i.companyAId)) continue;
    seen.add(i.companyAId);
    targets.push({ id: i.companyAId, name: i.companyA.name });
    if (targets.length >= limit) break;
  }

  const out: DraftResult = { drafted: 0, skipped: [], costUsd: 0 };

  for (const t of targets) {
    try {
      const r = await draftForSupplier(businessId, t.id);
      if ("skipped" in r) out.skipped.push({ company: t.name, why: r.skipped });
      else {
        out.drafted++;
        out.costUsd += r.costUsd;
      }
    } catch (e) {
      out.skipped.push({ company: t.name, why: e instanceof Error ? e.message.slice(0, 120) : "failed" });
    }
  }

  return out;
}
