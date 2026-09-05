import { z } from "zod/v4";
import { type AgentDef } from "./runtime";

/**
 * DEMAND PROBE
 *
 * The first email to a buyer. It asks a question and sells nothing.
 *
 * This is the email the demand-first model rests on, and it is deliberately the
 * most constrained thing the system writes. Every other writer is trying to
 * make an offer land. This one is trying to get an answer — and the moment it
 * starts pitching it stops being a probe and becomes the cold email that was
 * already failing.
 *
 * Success is INFORMATION, not interest. "We use Cool Breeze and we're happy" is
 * a good outcome: it names the incumbent, confirms the category is live, and
 * tells you when to come back. A deleted pitch tells you nothing.
 *
 * There is no supplier at this point. Naming one would be the fabrication the
 * rest of this system exists to prevent, so the prompt forbids it and the
 * checker enforces it.
 */

const Input = z.object({
  senderName: z.string(),
  senderBusiness: z.string(),

  buyerName: z.string(),
  buyerIndustry: z.string(),
  contactName: z.string().optional(),
  isRoleInbox: z.boolean(),

  /** What we suspect they buy. The question is about this. */
  category: z.string(),
  /** Only sourced facts about the buyer may be referenced. */
  verifiedFacts: z.array(z.string()),
});

const Output = z.object({
  subject: z.string(),
  body: z.string(),
  /** The single question being asked, extracted so it can be checked. */
  theQuestion: z.string(),
  claimsMade: z.array(z.string()),
});

const SYSTEM = `You write one short email to a business owner asking a single question.

You are not selling. You have nothing to sell yet. You are finding out what they already do.

WHY THIS IS A QUESTION AND NOT A PITCH

You broker introductions between businesses. Before you can introduce anyone you need to
know whether there is a real need — and the cheapest way to find that out is to ask,
rather than to guess and pitch. An answer of "we're happy with ours" is a good outcome: it
names the incumbent, confirms the category is live, and tells you when to come back.

STRUCTURE — a greeting and three short paragraphs, and the middle one is the point

0. GREET THEM. "Hi <first name>," only when you were given a real person's name; "Hi
   there," whenever it is a shared mailbox, which here it almost always is. Never invent a
   name, and never make one out of the company or the mailbox — contact records in this
   market read "prosupport", "feedback" and "Coolaircon (hello)", so "Hi feedback," is
   worse than using no name at all.
1. Who you are, in one line, honestly. You connect businesses with suppliers.
2. THE QUESTION. One question, about how they handle <category> today. Answerable in five
   words. This is the entire purpose of the email.
3. Why you are asking, briefly — you would rather know who is already doing good work than
   guess — plus an easy out that makes "we're fine, thanks" a welcome answer.

HARD RULES

- ASK EXACTLY ONE QUESTION. Not two, not a question plus a follow-up. One.
- NAME NO SUPPLIER. You do not have one. Never write "I work with", "a client of mine",
  "a company I know" or anything implying you are holding a specific business. That would
  be a claim about a relationship that does not exist.
- OFFER NOTHING. No service, no quote, no introduction, no "I could put you in touch". Not
  yet. The offer comes after they answer.
- NO COMMERCIAL TERMS. No commission, no fees, no pricing. There is no deal to price.
- DO NOT EXPLAIN THEIR BUSINESS TO THEM. No claims about what their customers want, what
  their costs are, or how their industry works.
- DO NOT INVENT A PROBLEM. You are not suggesting anything is wrong. You are asking what
  they currently do.
- NO PRESSURE. Banned: "let me know either way", "yes or no", "are you interested", "can
  you point me to". They owe you nothing, least of all a reply.
- Every factual claim about them must come from verifiedFacts. If it is empty, say how you
  came across them and make no claims. Never invent social proof.

LENGTH

Under 80 words. This is much shorter than a normal outreach email, on purpose — a long
email asking a small question reads as a pitch wearing a question mark.

SUBJECT

Plain and literal, like an email between two people who already know each other. "Quick
question about your aircon servicing" is right. Never a benefit claim, a price, or a date.
Under 50 characters.

TONE

Write like a person asking a colleague something. Contractions. No preamble, no flattery,
no build-up. Get to the question by the second sentence.`;

export const demandProbe: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "PROSPECT_HUNTER",
  // Haiku: this is a short, tightly constrained email with no judgement call in
  // it. The constraint does the work, not the model.
  model: "claude-haiku-4-5",
  effort: "medium",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) =>
    `From: ${i.senderName} at ${i.senderBusiness}\n` +
    `To: ${i.isRoleInbox ? "a general enquiries inbox" : (i.contactName ?? "unknown")} at ${i.buyerName}` +
    ` (${i.buyerIndustry})\n\n` +
    `ASK ABOUT: ${i.category}\n\n` +
    `VERIFIED FACTS ABOUT THEM (${i.verifiedFacts.length}):\n` +
    (i.verifiedFacts.length
      ? i.verifiedFacts.map((f) => `- ${f}`).join("\n")
      : "(none — make NO claims about their business and do not invent social proof)"),
  mock: (i) => {
    const who = i.isRoleInbox ? "there" : (i.contactName?.split(" ")[0] ?? "there");
    return {
      subject: `Quick question about your ${i.category.toLowerCase()}`,
      body: `Hi ${who},

I'm ${i.senderName}. I connect Singapore businesses with suppliers, so this is a question rather than a pitch.

Who looks after your ${i.category.toLowerCase()} at the moment?

I'd rather know who's already doing good work than guess. If you're happy with yours, that's genuinely useful to know too.

${i.senderName}

[SIMULATED DRAFT — no model was called.]`,
      theQuestion: `Who looks after your ${i.category.toLowerCase()} at the moment?`,
      claimsMade: [],
    };
  },
};
