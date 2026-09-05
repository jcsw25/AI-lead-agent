import { z } from "zod/v4";
import { type AgentDef } from "./runtime";

/**
 * ACQUISITION ENQUIRY
 *
 * The first email to an owner about buying their business.
 *
 * This is the most delicate thing the system writes, and the reason is not
 * tone. Every other email here asks about a purchase the recipient makes
 * routinely. This one asks a stranger about the thing they have spent fifteen
 * years building, the thing their staff depend on, and quite possibly the
 * largest financial decision of their life. Getting it wrong is not a wasted
 * send — it is an insult.
 *
 * Two failure modes, and they pull in opposite directions:
 *
 *   Too aggressive. "I'd like to buy your business" from an unknown name reads
 *   as either a scam or an insult. Worse is the version that implies the
 *   business is struggling — the tell of every predatory approach in this
 *   category, and the fastest way to be reported.
 *
 *   Too vague. "I'd love to connect" wastes the one approach you get. An owner
 *   who might sell cannot say yes to a sentence that does not ask anything.
 *
 * What works is a plain, specific, low-cost question with a real "no" attached,
 * from somebody who says who they are. The ask is not the sale — it is
 * permission for a second email.
 *
 * TWO ORIGINS, TWO EMAILS. A LISTED business advertised itself and expects
 * enquiries: there, being businesslike and referencing the listing is correct,
 * and being coy wastes their time. A PROPRIETARY owner has told nobody
 * anything, and treating them as a seller is the mistake.
 *
 * Note what this agent never does: it never states a price, never values the
 * business, and never claims to have funding it has not got. Those are the
 * claims that turn a cold email into a misrepresentation.
 */

const Input = z.object({
  senderName: z.string(),
  senderBusiness: z.string(),

  targetName: z.string(),
  industry: z.string(),
  contactName: z.string().optional(),
  isRoleInbox: z.boolean(),

  /** LISTED changes the email completely — they advertised, so say so. */
  origin: z.enum(["LISTED", "PROPRIETARY"]),
  /** For LISTED: where it was seen, so the opening is checkable. */
  listingSource: z.string().optional(),
  /** For LISTED: figures the listing itself published. Never our estimates. */
  statedFacts: z.array(z.string()),

  /**
   * The rung being asked for. One per email, never several — an owner who has
   * not said they would sell cannot be asked for financials.
   */
  ask: z.enum(["OPEN_TO_SELLING", "NDA", "FINANCIALS"]),
});

const Output = z.object({
  subject: z.string(),
  body: z.string(),
  /** The single question, extracted so it can be checked mechanically. */
  theQuestion: z.string(),
  claimsMade: z.array(z.string()),
});

const SYSTEM = `You write one short email to a business owner about the possibility of buying
their business.

Treat this as the most consequential email in the system. For most owners the business is
their life's work and their retirement. An approach that reads as opportunistic, predatory,
or automated does real harm and ends the conversation permanently.

WHO YOU ARE

You are a named person looking to buy and run a business in this industry. You are not a
broker, not an intermediary, and not "representing a client" — never claim to be any of
those, and never imply a fund or a group behind you that has not been named to you.

THE ASK, WHICH IS ONE RUNG ONLY

OPEN_TO_SELLING  Ask only whether they would ever consider selling, or would be open to a
                 conversation about it. Nothing else. Not a price, not a meeting agenda,
                 not financials.
NDA              They have already said they would consider it. Offer to sign a mutual NDA
                 so the conversation can be specific. Do not ask for numbers in this email.
FINANCIALS       An NDA is in place. Ask for the specific documents — two to three years of
                 P&L and the current balance sheet — and say what happens next.

Never ask for a rung they have not reached. Asking an owner who has said nothing for their
EBITDA is the single fastest way to be ignored and reported.

HARD RULES

- NEVER STATE OR SUGGEST A PRICE, a valuation, a multiple, or a range. You have not seen
  their numbers. Any figure would be invented.
- NEVER IMPLY THE BUSINESS IS STRUGGLING, declining, out of date, or that the owner is
  getting old, slowing down, or should retire. This is the signature of a predatory
  approach. No "I noticed you haven't updated…", no "in this difficult market".
- NEVER CLAIM FUNDING, backing, a fund, other acquisitions, or a track record you were not
  given. No "we've acquired twelve businesses", no "we have capital ready to deploy".
- NO URGENCY, NO DEADLINE, NO SCARCITY. None. Not "before year end", not "while we're
  looking at a few".
- ONE QUESTION. Answerable in one line.
- MAKE "NO" EASY AND EXPLICIT. Say plainly that a no is a completely fine answer and you
  will not follow up. Then it must be true.
- NEVER ASK THEM TO KEEP IT CONFIDENTIAL FROM THEIR OWN PEOPLE, and never suggest going
  around a partner, co-owner or manager.
- DO NOT EXPLAIN THEIR BUSINESS OR THEIR INDUSTRY TO THEM. They have run it for years.
- For a PROPRIETARY approach, acknowledge plainly that they have not advertised anything and
  that you know this is out of the blue. Pretending otherwise is transparently false.
- For a LISTED approach, say where you saw the listing. You may reference figures the
  LISTING ITSELF published, from statedFacts, and nothing else.

LENGTH

Under 120 words for OPEN_TO_SELLING. This is a short email. A long one reads as a pitch and
gives an owner a hundred words in which to find a reason to be annoyed.

SUBJECT

Plain and human. "Would you ever consider selling?" is honest and works. Never a benefit
claim, never a valuation, never anything that reads as marketing. Under 55 characters.

TONE

Direct, respectful, unmistakably written by a person. Contractions. No flattery, no
build-up, no corporate voice. Say the real thing in the first two sentences — an owner who
reaches paragraph three before understanding what you want stops reading at paragraph two.`;

export const acquisitionEnquiry: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "PROSPECT_HUNTER",
  // Sonnet rather than Haiku, unlike the demand probe. That email asks about a
  // service contract; this one has to hold a respectful register across a
  // genuinely sensitive subject, where the difference between "candid" and
  // "presumptuous" is a matter of phrasing rather than of rules.
  model: "claude-sonnet-5",
  effort: "medium",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) =>
    `From: ${i.senderName} at ${i.senderBusiness}\n` +
    `To: ${i.isRoleInbox ? "a general enquiries inbox" : (i.contactName ?? "the owner")} at ${i.targetName}` +
    ` (${i.industry})\n\n` +
    `APPROACH: ${i.origin}` +
    (i.origin === "LISTED"
      ? ` — they advertised on ${i.listingSource ?? "a marketplace"}. Reference the listing.\n`
      : ` — they have advertised NOTHING. Acknowledge this is out of the blue.\n`) +
    `ASK FOR: ${i.ask}\n\n` +
    (i.statedFacts.length
      ? `FIGURES THE LISTING ITSELF PUBLISHED (you may reference these, and nothing else):\n` +
        i.statedFacts.map((f) => `- ${f}`).join("\n")
      : `NO PUBLISHED FIGURES. State no numbers of any kind.`),
  mock: (i) => {
    const who = i.isRoleInbox ? "there" : (i.contactName?.split(" ")[0] ?? "there");
    const body =
      i.origin === "LISTED"
        ? `Hi ${who},

I saw your listing on ${i.listingSource ?? "the marketplace"}. I'm ${i.senderName} — I'm looking to buy and run a ${i.industry.toLowerCase()} business in Singapore myself, rather than on behalf of anyone else.

Is it still available, and would you be open to a short call?

Happy to sign an NDA before we get into any detail. If it's already under offer, no problem at all.

${i.senderName}

[SIMULATED DRAFT — no model was called.]`
        : `Hi ${who},

This is out of the blue, so I'll be direct. I'm ${i.senderName}, and I'm looking to buy and run a ${i.industry.toLowerCase()} business here in Singapore.

You haven't advertised anything, so this may be completely the wrong time — but would you ever consider selling?

If the answer's no, that's a perfectly good answer and I won't chase it.

${i.senderName}

[SIMULATED DRAFT — no model was called.]`;
    return {
      subject: i.origin === "LISTED" ? `Your listing on ${i.listingSource ?? "the marketplace"}` : "Would you ever consider selling?",
      body,
      theQuestion:
        i.origin === "LISTED" ? "Is it still available, and would you be open to a short call?" : "Would you ever consider selling?",
      claimsMade: [],
    };
  },
};
