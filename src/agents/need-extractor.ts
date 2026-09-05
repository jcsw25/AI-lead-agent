import { z } from "zod/v4";
import { type AgentDef } from "./runtime";

/**
 * NEED EXTRACTOR
 *
 * Reads a reply and pulls out what the company actually said they need.
 *
 * This is the step that turns the demand-first model from an idea into a
 * working loop. Before it, a reply was classified HOT or NEGATIVE and nothing
 * more — so a Need could never leave SUSPECTED, and 746 of them sat as
 * inferences with no path to becoming evidence.
 *
 * A model is used here where the reply classifier deliberately does not, and
 * the reason is the shape of the problem. Classification is a small closed set
 * that patterns handle well and auditably. "Who do you currently use, and are
 * you looking to change" is open free text written by a stranger — patterns
 * cannot read it.
 *
 * The safeguard is not the prompt. Every quoted phrase must appear verbatim in
 * the reply, and that is checked in code after the call. A need that cannot be
 * traced to words the person actually wrote does not get confirmed, because the
 * whole value of a confirmed need is that a supplier can be told about it
 * truthfully.
 */

const Input = z.object({
  /** What we asked them. */
  ourQuestion: z.string(),
  /** The category we were asking about. */
  category: z.string(),
  companyName: z.string(),
  /** Their reply, as received. */
  replyText: z.string(),
});

const Output = z.object({
  /**
   * Did they answer the question at all? A reply can be warm and still tell us
   * nothing about their supplier situation.
   */
  answeredTheQuestion: z.boolean(),
  /**
   * True only if they need THE CATEGORY WE ASKED ABOUT.
   *
   * Named for the constraint because the unqualified version failed a test: a
   * reply reading "aircon we handle in house, but we're looking for pest
   * control" came back hasNeed true. Every word of that was accurate and the
   * quote was real, so the verbatim gate passed it — and the aircon need would
   * have been confirmed on the strength of a sentence about pest control. That
   * is the exact failure this whole module exists to prevent, and it got
   * through because the field did not say what it meant.
   */
  hasNeedInThisCategory: z.boolean(),
  /**
   * The exact words that establish it. MUST be copied character for character
   * from the reply — it is checked, and an inexact quote voids the extraction.
   */
  verbatim: z.string().nullable(),
  /** Who they use today, if named. Null if they did not say. */
  incumbent: z.string().nullable(),
  urgency: z.enum(["NOW", "THIS_QUARTER", "SOMEDAY", "NOT_IN_MARKET"]),
  /** Only if they volunteered a figure. Never inferred. */
  budgetHint: z.string().nullable(),
  /** A different need they mentioned that we did not ask about. */
  otherNeed: z.string().nullable(),
  /** Do they want to be left alone? Acted on immediately if so. */
  wantsNoContact: z.boolean(),
  reasoning: z.string(),
});

const SYSTEM = `You read one reply to a cold email and extract what the company actually said.

You are not interpreting, persuading, or looking for an opening. You are recording facts
that a third party will later be told. Somebody will be emailed on the strength of this,
so an invented detail becomes a lie told to a stranger.

RULES

1. verbatim MUST be copied character for character from the reply. Not paraphrased, not
   tidied, not corrected. It is checked against the original text and an inexact quote
   discards the whole extraction. If nothing in the reply establishes a need, return null.

2. hasNeedInThisCategory is true ONLY if they need THE CATEGORY NAMED ABOVE — they said they
   need it, are unhappy with their current arrangement of it, or are open to alternatives for
   it. "We're happy with ours" is FALSE, and that is a perfectly good outcome: it tells us the
   category is live for them and roughly when to return.

   A need in a DIFFERENT category is FALSE here and belongs in otherNeed, however clearly they
   stated it. "We handle aircon in house, but we're looking for pest control" is
   hasNeedInThisCategory FALSE for aircon, with otherNeed "pest control". This one matters more
   than any other rule on this list: a supplier will be told a company confirmed a need for
   what THEY sell, and putting a different trade's need in this field is how that becomes false.

3. incumbent is the supplier they NAMED, as a proper name. If they referred to one without
   naming it — "our current guys", "the same company for years", "our contractor" — that is
   null, because this field is quoted to a third party and a placeholder reads as invented.
   Never guess a name from the industry.

4. urgency:
   NOW           they said soon, urgent, this month, or that something is broken
   THIS_QUARTER  a date or season they named
   SOMEDAY       open in principle with no timing
   NOT_IN_MARKET happy, locked into a contract, or not interested
   When they gave no timing at all, SOMEDAY. Do not upgrade urgency out of optimism.

5. budgetHint only if they stated a figure or a range. Never inferred from anything.

6. otherNeed captures something they mentioned that we did not ask about — often the more
   valuable half of the reply. "Not aircon but we do need help with X" belongs here.

7. wantsNoContact is true for any request to stop, remove, unsubscribe, or not be
   contacted again. Err toward true: wrongly stopping costs one lead, wrongly continuing
   is a compliance failure.

8. answeredTheQuestion is false for auto-replies, out-of-office, wrong-person forwards and
   anything that does not address what was asked, however friendly.

If the reply is ambiguous, say so in reasoning and set hasNeedInThisCategory false. An uncertain need
recorded as certain is worse than no need at all.`;

export const needExtractor: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "CONVERSATION",
  // Haiku: reading a short reply and copying phrases out of it. The constraint
  // and the verbatim check do the work, not model scale.
  model: "claude-haiku-4-5",
  effort: "medium",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) =>
    `Company: ${i.companyName}\n` +
    `We asked about: ${i.category}\n` +
    `Our question was: "${i.ourQuestion}"\n\n` +
    `THEIR REPLY, verbatim:\n---\n${i.replyText.slice(0, 3000)}\n---`,
  mock: () => ({
    answeredTheQuestion: false,
    hasNeedInThisCategory: false,
    verbatim: null,
    incumbent: null,
    urgency: "SOMEDAY" as const,
    budgetHint: null,
    otherNeed: null,
    wantsNoContact: false,
    reasoning: "No ANTHROPIC_API_KEY, so the reply was not read.",
  }),
};

/**
 * Does the quoted phrase actually appear in the reply?
 *
 * Compared on letters and digits only, so punctuation, quote marks and line
 * wrapping do not cause a false rejection — but the words themselves must be
 * the ones the person wrote.
 */
export function quoteIsReal(verbatim: string | null, replyText: string): boolean {
  if (!verbatim) return true;
  const flatten = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = flatten(verbatim);
  if (q.length < 8) return false;
  return flatten(replyText).includes(q);
}
