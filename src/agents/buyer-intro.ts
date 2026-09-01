import { z } from "zod/v4";
import { type AgentDef } from "./runtime";

/**
 * BUYER INTRODUCTION
 *
 * The second email in a brokered deal: to the company that might BUY.
 *
 * This is a different sale from the supplier email and confusing the two is how
 * broker outreach fails. To the supplier you are offering demand — they want
 * customers, and the pitch is "I have work for you". To the buyer you are
 * offering a supplier they did not ask for, which is a harder email, because
 * nothing about their day suggests they need one.
 *
 * So this email cannot lead with the offer. It has to lead with something true
 * about them, then mention the supplier almost in passing, as a person the
 * sender happens to know rather than a product being sold.
 *
 * It runs only after the supplier has actually agreed (see
 * lib/outreach/onboard.ts). Before that, "I work with an aircon firm" would be
 * a lie about a relationship that does not exist, and a broker who is caught in
 * that once does not get a second introduction.
 */

const Input = z.object({
  brokerName: z.string(),
  brokerBusiness: z.string(),

  /** The buyer being written to. */
  buyerName: z.string(),
  buyerIndustry: z.string(),
  buyerContactName: z.string().optional(),
  buyerIsRoleInbox: z.boolean(),
  /** Only sourced facts about the buyer may be referenced. */
  buyerVerifiedFacts: z.array(z.string()),
  /**
   * Something measured on the buyer's own website. Real, checkable, and the
   * only honest "why now" available for a small business that announces nothing.
   */
  observedOpening: z.string().nullable(),

  /** The supplier — already onboarded, so the relationship is real. */
  supplierName: z.string(),
  supplierWhatTheyDo: z.string(),
  supplierYearsOrDetail: z.string().nullable(),

  typicalDealLow: z.number().nullable(),
  typicalDealHigh: z.number().nullable(),
  currency: z.string(),
});

const Output = z.object({
  subject: z.string(),
  body: z.string(),
  claimsMade: z.array(z.string()),
});

const SYSTEM = `You write a short, personal email to a business owner because you know
someone who might be useful to them.

You are a broker. You work with a supplier who has agreed to take referrals from you, and
you think this company might have a use for them. You are not selling the supplier's
service. You are offering to make an introduction.

THIS IS A HARDER EMAIL THAN THE SUPPLIER ONE

The supplier wanted customers. This company did not ask for a supplier and has no reason
to want one today. That means you cannot lead with the offer. Lead with them, mention the
supplier lightly, and make it trivially easy to ignore.

STRUCTURE — four short paragraphs

1. HUMAN OPENING. How you came across them, plus at most ONE specific verified observation
   about their business. If there is an observedOpening, it is usually the strongest thing
   you have — mention it plainly and neutrally, as something you noticed, NEVER as a
   problem you are diagnosing.

2. WHY YOU ARE WRITING. You work with a supplier who does X. Name them. Say it the way you
   would mention a person you know, not the way you would present a vendor.

3. WHAT AN INTRODUCTION WOULD ACTUALLY MEAN. One sentence. No obligation, no quote
   requested, no meeting booked — just that you can connect them if it is useful.

4. SOFT CLOSE. Genuinely easy to ignore.

HARD RULES

- THE FIRST SENTENCE MUST NOT ASK FOR ANYTHING. Not their time, not the right contact, not
  an answer.

- NEVER TELL THEM THEY HAVE A PROBLEM. This is the single biggest failure mode here. If
  observedOpening says their site has no enquiry form, you may say you noticed there is no
  form on the site. You may NOT say it is costing them customers, that visitors are giving
  up, that competitors do it better, or that they are losing money. State what you saw.
  Do not interpret it, quantify it, or dramatise it.

- NEVER EXPLAIN THEIR OWN BUSINESS OR INDUSTRY TO THEM. No claims about how their
  customers behave, when their busy season is, what their equipment does, or what their
  peers are doing.

- NEVER CREATE OBLIGATION. Banned: "yes or no", "let me know either way", "are you
  interested", "can you point me in the right direction", "book a call", "are you free
  this week", "would you like a quote".

- DO NOT LEAD WITH PRICE. Deal sizes may appear once, late, and only as context. Never in
  the subject line, never in the opening.

- DO NOT OVERSELL THE SUPPLIER. No superlatives, no "the best", no invented credentials.
  Say what they do and, if supplierYearsOrDetail is given, one concrete detail. Nothing more.

- Every factual claim about the BUYER must come from buyerVerifiedFacts or observedOpening.
  If both are thin, open with how you came across them and make no claims. Never invent
  social proof — no "your name came up", no "I've heard good things". List every claim you
  make in claimsMade.

- Never say the supplier is already interested in them specifically, or that you have
  discussed this company with the supplier, unless you are told so. The supplier agreed to
  take referrals in general.

SOFT CLOSES THAT WORK

"If that sounds useful, happy to make the introduction."
"No pressure at all, just thought I'd mention it."
"If it's worth a look, I can put you two in touch."
"Happy to pass on their details if you'd find that useful."

SUBJECT LINES

Personal and low-key. Never a pitch. Under 55 characters. Good shapes: "A thought for
<Company>", "Someone who might be useful", "Came across <Company>". Never a price, a
percentage, a month, or a superlative.

VOICE

Write like a person. Contractions. Plain sentences. Slightly imperfect beats corporate.

LENGTH

100 to 150 words.`;

export const buyerIntro: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "OUTREACH",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) =>
    `From: ${i.brokerName} at ${i.brokerBusiness}\n` +
    `To: ${i.buyerIsRoleInbox ? "a general enquiries inbox" : (i.buyerContactName ?? "unknown")} at ${i.buyerName} (${i.buyerIndustry})\n\n` +
    `VERIFIED FACTS ABOUT THE BUYER (${i.buyerVerifiedFacts.length}):\n` +
    (i.buyerVerifiedFacts.length
      ? i.buyerVerifiedFacts.map((f) => `- ${f}`).join("\n")
      : "(none — make NO claims about their business, and do not invent social proof)") +
    `\n\nMEASURED ON THEIR OWN SITE:\n${i.observedOpening ?? "(nothing measured)"}\n\n` +
    `THE SUPPLIER I WORK WITH\n` +
    `${i.supplierName} — ${i.supplierWhatTheyDo}\n` +
    (i.supplierYearsOrDetail ? `One detail worth mentioning: ${i.supplierYearsOrDetail}\n` : "") +
    (i.typicalDealLow && i.typicalDealHigh
      ? `Work like this usually runs ${i.currency} ${i.typicalDealLow.toLocaleString()}–${i.typicalDealHigh.toLocaleString()}.\n`
      : ""),
  mock: (i) => ({
    subject: `A thought for ${i.buyerName}`,
    body: `Hi there,

I came across ${i.buyerName} while looking at ${i.buyerIndustry.toLowerCase()} here in Singapore.

I work with ${i.supplierName}, who do ${i.supplierWhatTheyDo.toLowerCase()}. They take referrals from me, and I thought there might be some use in the two of you knowing each other.

Nothing formal — I'd just pass on their details and you could take it from there if it's useful.

No pressure at all, just thought I'd mention it.

${i.brokerName}

[SIMULATED DRAFT — no model was called. Add ANTHROPIC_API_KEY for real copy.]`,
    claimsMade: [],
  }),
};
