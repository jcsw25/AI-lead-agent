import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";
import { checkDraft, violationBrief } from "@/lib/outreach/quality";

/**
 * INTRODUCTION PAIR
 *
 * Drafts both halves of a brokered introduction in one pass:
 *
 *   A-side  to the supplier  — "can I bring you buyers?"
 *   B-side  to the buyer     — "I work with a supplier who does X"
 *
 * Written together on purpose. The two emails have to agree: if you promise the
 * supplier you are approaching law firms about corporate gifting, the buyer
 * email had better be about corporate gifting to a law firm. Generating them
 * separately is how brokers end up pitching things their supplier never agreed
 * to.
 *
 * Neither email invents a relationship that does not exist yet. The A-side asks
 * permission; the B-side says "I work with" rather than claiming an exclusive
 * or a signed agreement, because at draft time there is neither.
 */

const Email = z.object({
  subject: z.string(),
  body: z.string(),
  /** Anything asserted about the recipient, so it can be checked. */
  claimsMade: z.array(z.string()),
});

const Input = z.object({
  brokerName: z.string(),
  brokerBusiness: z.string(),

  supplierName: z.string(),
  supplierWhatTheySell: z.string(),
  supplierContactName: z.string().optional(),
  supplierIsRoleInbox: z.boolean(),

  buyerIndustry: z.string(),
  buyerExampleName: z.string().optional(),
  buyerContactName: z.string().optional(),
  buyerIsRoleInbox: z.boolean(),

  whatAHas: z.string(),
  whatBNeeds: z.string(),
  trigger: z.string(),
  timingWindow: z.string().optional(),
  commissionRate: z.number().nullable(),
  dealLow: z.number().nullable(),
  dealHigh: z.number().nullable(),
  currency: z.string(),
  verifiedFacts: z.array(z.string()),
});

const Output = z.object({
  toSupplier: Email,
  toBuyer: Email,
  /** One line the operator can read before sending, naming the weakest point. */
  reviewNote: z.string(),
});

const SYSTEM = `You draft the two emails a broker sends to set up an introduction.

Neither is a sales email. Both are the start of a conversation with someone who did not
ask to hear from you and owes you nothing.

SHARED RULES — these decide whether either email gets read

- THE FIRST SENTENCE MUST NOT ASK FOR ANYTHING. Never open with "Could you point me to",
  "Can you", "Are you the person", "I'm reaching out", "Quick question", or "I hope this
  finds you well". Open with how you came across them and, at most, ONE verified
  observation about their business.

- NEVER EXPLAIN THEIR BUSINESS TO THEM AND NEVER INVENT A PROBLEM. No claims about what
  their customers do, what revenue they might be losing, what happens when something
  fails, or when their busy season is. They know. Naming WHO is looking is fine;
  explaining WHY they should care about their own trade is not.

- NEVER CREATE OBLIGATION. Banned outright: "yes or no", "let me know either way", "are
  you interested", "can you point me in the right direction", "worth a 15-minute call",
  "book a call", "are you available this week". Close with something they can act on if
  curious and ignore if not.

- DO NOT LEAD WITH MONEY. Commission and terms belong late and light, in one sentence,
  never in the opening or the subject line.

- ONE OBSERVATION, NOT FIVE. Listing everything you know reads like scraped data.

- Only state facts about the recipient that appear in verifiedFacts. If it is empty, make
  NO claims about them at all and never invent social proof — no "your name came up", no
  "I've heard good things". List every factual claim in claimsMade.

- Writing to a role inbox (info@, sales@) does not change the opening. If you need the
  right person, ask at the END, lightly: "if someone else handles this, happy to be
  pointed their way."

EMAIL 1 — to the SUPPLIER

You are offering them work. Structure: how you came across them and one observation ->
you are talking to companies looking for what they do and are putting together a small
group of suppliers you can refer to -> the arrangement in one sentence, no upfront fee,
commission only on what closes -> soft close.

EMAIL 2 — to the BUYER

Harder: they did not ask for a supplier. Structure: how you came across them and one
observation -> you work with a supplier who does X, mentioned the way you would mention
someone you know -> what an introduction would actually mean, which is nothing binding ->
soft close. Say "I work with" and never imply an exclusive, a partnership or a signed
agreement. Do not quote firm prices; a range only if one was supplied, and late.

BOTH

- The two emails must describe the SAME deal. A promise made in one is a commitment in
  the other.
- Subject lines curious and personal, under 55 characters. Never a price, a percentage,
  a month, or a market claim.
- Write like a person. Contractions. Plain sentences. 100 to 160 words each.`;


const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "OUTREACH",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) => `Broker: ${i.brokerName} at ${i.brokerBusiness}

SUPPLIER (email 1 goes here)
${i.supplierName} — ${i.supplierWhatTheySell}
Writing to: ${i.supplierIsRoleInbox ? "a general enquiries inbox" : (i.supplierContactName ?? "unknown contact")}
What they have: ${i.whatAHas}

BUYER (email 2 goes here)
Segment: ${i.buyerIndustry}${i.buyerExampleName ? `\nSpecific company: ${i.buyerExampleName}` : ""}
Writing to: ${i.buyerIsRoleInbox ? "a general enquiries inbox" : (i.buyerContactName ?? "unknown contact")}
What they need: ${i.whatBNeeds}

WHY NOW
${i.trigger}${i.timingWindow ? `\nTiming: ${i.timingWindow}` : ""}

MY TERMS
${i.commissionRate ? `${i.commissionRate}% of closed business` : "commission on closed business"}, nothing up front, no exclusivity.
${i.dealLow && i.dealHigh ? `Deals in this space typically run ${i.currency} ${i.dealLow.toLocaleString()}–${i.dealHigh.toLocaleString()}.` : ""}

VERIFIED FACTS (${i.verifiedFacts.length}) — the only things you may assert about either party:
${i.verifiedFacts.length ? i.verifiedFacts.map((f) => `- ${f}`).join("\n") : "(none — make no factual claims about either company)"}`,
  mock: (i) => {
    const supTo = i.supplierIsRoleInbox ? "there" : (i.supplierContactName?.split(" ")[0] ?? "there");
    const buyTo = i.buyerIsRoleInbox ? "there" : (i.buyerContactName?.split(" ")[0] ?? "there");
    const terms = i.commissionRate ? `${i.commissionRate}% of anything that closes` : "a commission on anything that closes";
    return {
      toSupplier: {
        subject: `${i.buyerIndustry} buyers for ${i.supplierName}`,
        body: `Hi ${supTo},\n\n${i.trigger} — which is when ${i.buyerIndustry.toLowerCase()} start sourcing what you make.\n\nI find those companies and introduce them. You quote as normal; I take ${terms}. Nothing up front, no exclusivity, stop any time.\n\nWorth a quick call?\n\n${i.brokerName}\n\n[SIMULATED — no model was called.]`,
        claimsMade: [],
      },
      toBuyer: {
        subject: `${i.whatBNeeds.split(/[.,]/)[0]} — ${i.buyerIndustry}`,
        body: `Hi ${buyTo},\n\n${i.trigger}\n\nI work with ${i.supplierName}, who supply ${i.supplierWhatTheySell.toLowerCase()}. Worth a short call or a sample?\n\n${i.brokerName}\n\n[SIMULATED — no model was called.]`,
        claimsMade: [],
      },
      reviewNote: "Simulated draft — add ANTHROPIC_API_KEY for real copy.",
    };
  },
};

/** Draft both emails for one company against one pairing. */
export async function draftIntroPair(
  businessId: string,
  companyId: string,
  pairingId: string,
  side: "A" | "B" = "A",
) {
  const [company, pairing, business] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: companyId }, include: { contacts: true, signals: true } }),
    db.pairing.findUniqueOrThrow({ where: { id: pairingId } }),
    db.business.findUniqueOrThrow({ where: { id: businessId }, include: { sendPolicy: true, region: true } }),
  ]);

  const named = company.contacts.find(
    (c) => c.jobTitle && c.jobTitle !== "General enquiries" && !c.email?.startsWith("unknown-"),
  );
  const anyContact = company.contacts.find((c) => c.email && !c.email.startsWith("unknown-")) ?? company.contacts[0];
  const contact = named ?? anyContact;

  // ADR-003: only sourced, unexpired facts may enter outbound copy.
  const verifiedFacts = company.signals
    .filter((s) => s.verification === "VERIFIED" && (!s.expiresAt || s.expiresAt > new Date()))
    .map((s) => `${company.name}: ${s.title}${s.sourceUrl ? ` (${s.sourceUrl})` : ""}`);

  // If the company sits on the buyer side, the pairing reads in reverse.
  const supplierIsThisCompany = side === "A";

  const agentInput = {
    brokerName: business.sendPolicy?.senderName ?? business.name,
      brokerBusiness: business.name,
      supplierName: supplierIsThisCompany ? company.name : pairing.supplierIndustry,
      supplierWhatTheySell: supplierIsThisCompany
        ? (company.description ?? pairing.supplierIndustry)
        : pairing.whatAHas,
      supplierContactName: supplierIsThisCompany ? named?.fullName : undefined,
      supplierIsRoleInbox: supplierIsThisCompany ? !named : true,
      buyerIndustry: supplierIsThisCompany ? pairing.buyerIndustry : (company.industry ?? pairing.buyerIndustry),
      buyerExampleName: supplierIsThisCompany ? undefined : company.name,
      buyerContactName: supplierIsThisCompany ? undefined : named?.fullName,
      buyerIsRoleInbox: supplierIsThisCompany ? true : !named,
      whatAHas: pairing.whatAHas,
      whatBNeeds: pairing.whatBNeeds,
      trigger: pairing.trigger,
      timingWindow: pairing.timingWindow ?? undefined,
      commissionRate: pairing.commissionRate ? Number(pairing.commissionRate) : null,
      dealLow: pairing.typicalDealLow ? Number(pairing.typicalDealLow) : null,
      dealHigh: pairing.typicalDealHigh ? Number(pairing.typicalDealHigh) : null,
      currency: pairing.currency,
    verifiedFacts,
  };

  // The same mechanical gate the other writers use. Both halves are checked —
  // an introduction is only as good as its weaker email.
  let res = await runAgent(agent, agentInput, { businessId });
  let violations = [
    ...checkDraft(res.output.toSupplier.subject, res.output.toSupplier.body),
    ...checkDraft(res.output.toBuyer.subject, res.output.toBuyer.body),
  ];

  if (violations.length) {
    const retry = await runAgent(
      agent,
      { ...agentInput, verifiedFacts: [...verifiedFacts, `REWRITE. The previous attempt broke these rules:
${violationBrief(violations)}`] },
      { businessId },
    );
    const rv = [
      ...checkDraft(retry.output.toSupplier.subject, retry.output.toSupplier.body),
      ...checkDraft(retry.output.toBuyer.subject, retry.output.toBuyer.body),
    ];
    if (rv.length < violations.length) { res = retry; violations = rv; }
  }

  const { output, runId, simulated } = res;

  // Persist the half addressed to this company as a real draft, so it appears
  // in the approval queue and goes through the send gate like anything else.
  const mine = supplierIsThisCompany ? output.toSupplier : output.toBuyer;
  const message = contact
    ? await db.message.create({
        data: {
          businessId,
          contactId: contact.id,
          channel: "EMAIL",
          direction: "OUTBOUND",
          status: "PENDING_APPROVAL",
          subject: mine.subject,
          bodyText: mine.body,
          agentRunId: runId,
          classifierNotes: output.reviewNote,
        },
      })
    : null;

  return {
    toSupplier: output.toSupplier,
    toBuyer: output.toBuyer,
    reviewNote: output.reviewNote,
    messageId: message?.id ?? null,
    contactUsed: contact ? { name: contact.fullName, email: contact.email, phone: contact.phone } : null,
    simulated,
  };
}

export const introEmails = agent;
