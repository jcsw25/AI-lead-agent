import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";

/**
 * SUPPLIER RECRUITER
 *
 * Writes the cold email to Business A — the supplier we want to recruit.
 *
 * This is a different sale from the buyer-side pitch, and confusing the two is
 * the main way broker outreach fails. To a buyer you are selling a product. To
 * a supplier you are selling DEMAND, and they have heard "I can get you leads"
 * from every agency that ever cold-emailed them. The only thing that separates
 * this from that noise is naming a specific buyer segment and a specific reason
 * those buyers are about to spend.
 *
 * So the email must be concrete about the demand and honest about the terms.
 * Vague promises of "more clients" get deleted; "law firms buy client gifts in
 * October and I know which ones are hiring" gets a reply.
 */

const Email = z.object({ subject: z.string(), body: z.string() });

const Input = z.object({
  senderName: z.string(),
  senderBusiness: z.string(),
  supplierName: z.string(),
  supplierWhatTheySell: z.string(),
  contactName: z.string().optional(),
  contactRole: z.string().optional(),
  isRoleBasedInbox: z.boolean(),

  buyerIndustry: z.string(),
  whatTheyHave: z.string(),
  whatBuyersNeed: z.string(),
  trigger: z.string(),
  timingWindow: z.string().optional(),

  commissionRate: z.number().nullable(),
  typicalDealLow: z.number().nullable(),
  typicalDealHigh: z.number().nullable(),
  currency: z.string(),
  /** Only sourced facts about this supplier may be referenced. */
  verifiedFacts: z.array(z.string()),
});

const Output = z.object({
  initial: Email,
  followUps: z.array(Email.extend({ delayDays: z.number() })).max(2),
  claimsMade: z.array(z.string()),
});

const SYSTEM = `You write a short, personal email to a business owner because you think you
may have found an opportunity that could be useful to them.

You are not selling. You are starting a conversation.

WHO IS READING

Someone who runs a small firm and is good at their trade. They get a dozen automated
pitches a week and delete all of them. They do not need anything explained to them about
their own industry, their own customers, or their own risks. What would make them read on
is the sense that a real person looked at their business specifically and thought of them.

THE EMOTIONAL PROGRESSION YOU ARE AIMING FOR

"Nice to hear from you" -> "Why did you contact me?" -> "Oh, that's interesting" ->
"That could actually be useful" -> "Sure, tell me more."

NOT: "Who are you?" -> "Why are you asking me this?" -> "What's the catch?" -> delete.

STRUCTURE — four short paragraphs

1. HUMAN OPENING. How you came across them, plus at most ONE specific, verified
   observation about their business. Something that shows you actually looked. This is a
   sentence or two, not a paragraph.

2. WHY YOU ARE WRITING. The opportunity, framed as something you have and they might want:
   you are talking to companies looking for what they do, and you are putting together a
   small group of suppliers you can refer that work to. Say that their business looked
   like it might be a fit.

3. THE ARRANGEMENT, briefly and lightly. No upfront fee, no retainer, a commission only if
   something actually closes. This is a reassuring detail near the end, not the reason for
   the email. One sentence.

4. SOFT CLOSE. Something they can act on if curious and ignore if not.

HARD RULES

- The FIRST SENTENCE MUST NOT ASK THEM FOR ANYTHING. Not for their time, not for the right
  contact, not for an answer. Never open with "Could you", "Can you", "Are you the person",
  "I'm reaching out", "I wanted to introduce", "Quick question", or "I hope this finds you
  well".

- NEVER EXPLAIN THEIR BUSINESS TO THEM. Do not describe what their customers want, what
  happens when their equipment fails, how much a problem costs them, when their busy season
  is, or how their industry works. They know. Naming WHO is looking for their services is
  fine. Explaining WHY those buyers need it is not.

- NEVER INVENT A PROBLEM. No risk, no urgency, no "you may be losing". You are offering an
  upside, not warning them about a downside.

- NEVER CREATE OBLIGATION. Banned: "yes or no", "let me know either way", "are you
  interested", "do you accept referrals", "can you point me in the right direction", "book
  a 15-minute call", "are you available this week". They owe you nothing.

- DO NOT LEAD WITH MONEY. Commission, fees and terms belong in paragraph 3, never in the
  opening or the subject line.

- ONE OBSERVATION, NOT FIVE. Personalisation means one genuine detail, then move on.
  Listing everything you know reads like scraped data, which is exactly what it is.

- Every factual claim about their business must come from verifiedFacts. If verifiedFacts
  is thin, open with how you came across them and make no claims at all. An honest generic
  opening beats an invented specific one. List every claim you make in claimsMade.

- Do not claim a specific customer is already waiting unless verifiedFacts says so. Saying
  you are talking to companies in a sector is fine; naming a ready buyer that does not
  exist is not.

SOFT CLOSES THAT WORK

"If it's something you'd be open to exploring, happy to tell you a bit more."
"If it sounds potentially relevant, happy to have a quick chat."
"Would be good to hear what you think."
"No pressure either way, just thought it might be worth putting on your radar."
"If you're curious, I can send over a bit more detail."

SUBJECT LINES

Curious and personal, never a campaign. Lowercase or sentence case is fine. Good shapes:
"Potential fit for <Company>", "Came across <Company>", "A thought for <Company>",
"Possible opportunity". Never put a percentage, a price, a date range, a month, or a market
claim in the subject. Under 55 characters.

VOICE

Write like a person, not a department. Contractions throughout. Plain sentences. A
slightly imperfect natural sentence beats a polished corporate one. Do not use dashes to
join clauses the way marketing copy does.

LENGTH

100 to 160 words. If a sentence does not build warmth or move toward the opportunity, cut
it.`;

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "SUPPLIER_RECRUITER",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) => `From: ${i.senderName} at ${i.senderBusiness}
To: ${i.isRoleBasedInbox ? "a general enquiries inbox" : `${i.contactName}, ${i.contactRole ?? "unknown role"}`} at ${i.supplierName}

They sell: ${i.supplierWhatTheySell}
What they have: ${i.whatTheyHave}

THE DEMAND I AM OFFERING THEM
Buyer segment: ${i.buyerIndustry}
What those buyers need: ${i.whatBuyersNeed}
Why now: ${i.trigger}${i.timingWindow ? `\nTiming: ${i.timingWindow}` : ""}
Typical deal size: ${i.typicalDealLow && i.typicalDealHigh ? `${i.currency} ${i.typicalDealLow.toLocaleString()}–${i.typicalDealHigh.toLocaleString()}` : "unknown"}

MY TERMS
${i.commissionRate ? `${i.commissionRate}% commission on closed business` : "commission on closed business"}, nothing up front, no exclusivity.

Verified facts about them (${i.verifiedFacts.length}):
${i.verifiedFacts.length ? i.verifiedFacts.map((f) => `- ${f}`).join("\n") : "(none — make no factual claims about their business)"}`,
  mock: (i) => {
    const who = i.isRoleBasedInbox ? "there" : (i.contactName?.split(" ")[0] ?? "there");
    const terms = i.commissionRate ? `${i.commissionRate}%` : "a small cut";
    return {
      initial: {
        subject: `Sending you some ${i.buyerIndustry.split(",")[0].toLowerCase()} work`,
        body: `Hi ${who},

I'm ${i.senderName}. I work with ${i.buyerIndustry.toLowerCase()} around Singapore, and a few of them are looking for someone who does what you do.

Thought I'd check whether you'd want me to send them your way. You'd quote as normal, and I take ${terms} of anything that actually closes. Nothing up front, no exclusivity.

Happy to send the first one over and you can see what you think. If someone else handles this side of things, point me their way.

${i.senderName}

[SIMULATED DRAFT — no model was called. Add ANTHROPIC_API_KEY for real copy.]`,
      },
      followUps: [
        {
          delayDays: 6,
          subject: `Re: sending you some work`,
          body: `Hi ${who},

Just floating this back up in case it got buried. No rush either way.

${i.senderName}

[SIMULATED DRAFT]`,
        },
      ],
      claimsMade: [],
    };
  },
};

export async function runSupplierRecruiter(businessId: string, leadId: string) {
  const lead = await db.supplierLead.findUniqueOrThrow({
    where: { id: leadId },
    include: {
      company: { include: { contacts: { orderBy: { verification: "asc" } } } },
      pairing: true,
      business: { include: { sendPolicy: true, region: true } },
    },
  });

  const pairing = lead.pairing;
  if (!pairing) throw new Error("This lead is not attached to a pairing — attach one so the email has demand to offer.");

  // Prefer a named contact with a real address; fall back to the role inbox.
  const named = lead.company.contacts.find((c) => c.verification === "VERIFIED" && c.jobTitle !== "General enquiries");
  const role = lead.company.contacts.find((c) => c.jobTitle === "General enquiries");
  const contact = named ?? role;
  if (!contact) throw new Error("No contact route found for this supplier.");

  const claims = await db.claim.findMany({
    where: { companyId: lead.companyId, verification: "VERIFIED" },
    take: 6,
  });

  const { output, runId, simulated } = await runAgent(
    agent,
    {
      senderName: lead.business.sendPolicy?.senderName ?? lead.business.name,
      senderBusiness: lead.business.name,
      supplierName: lead.company.name,
      supplierWhatTheySell: lead.whatTheySell ?? lead.company.description ?? pairing.supplierIndustry,
      contactName: named?.fullName,
      contactRole: named?.jobTitle ?? undefined,
      isRoleBasedInbox: !named,
      buyerIndustry: pairing.buyerIndustry,
      whatTheyHave: pairing.whatAHas,
      whatBuyersNeed: pairing.whatBNeeds,
      trigger: pairing.trigger,
      timingWindow: pairing.timingWindow ?? undefined,
      commissionRate: pairing.commissionRate ? Number(pairing.commissionRate) : null,
      typicalDealLow: pairing.typicalDealLow ? Number(pairing.typicalDealLow) : null,
      typicalDealHigh: pairing.typicalDealHigh ? Number(pairing.typicalDealHigh) : null,
      currency: pairing.currency,
      verifiedFacts: claims.map((c) => `${c.field}: ${JSON.stringify(c.value)} (${c.sourceUrl ?? "no source"})`),
    },
    { businessId },
  );

  const message = await db.message.create({
    data: {
      businessId,
      supplierLeadId: leadId,
      contactId: contact.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      status: "PENDING_APPROVAL",
      subject: output.initial.subject,
      bodyText: output.initial.body,
      agentRunId: runId,
    },
  });

  await db.supplierLead.update({
    where: { id: leadId },
    data: { whyTheyNeedUs: pairing.whatBNeeds, targetBuyerIndustries: [pairing.buyerIndustry] },
  });

  return { messageId: message.id, simulated, followUps: output.followUps };
}

export const supplierRecruiter = agent;
