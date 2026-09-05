/**
 * Quality control for supplier outreach.
 *
 * The tone rules live in the prompt, but a prompt is a request, not a
 * guarantee. Two rewrites of the recruiter's instructions each produced copy
 * that still opened with an ask or lectured the recipient about their own
 * trade — the model complied with most rules and quietly dropped others. So the
 * rules that can be checked mechanically are checked mechanically, and a draft
 * that fails is regenerated with its failures fed back rather than saved.
 *
 * Everything here is a pattern match. Nothing calls a model.
 */

export type Violation = { rule: string; detail: string };

/** Openers that ask before they give. */
const COLD_OPENERS = [
  /^\s*(could|can|would)\s+you\b/i,
  /^\s*are\s+you\s+the\s+(person|one)\b/i,
  /^\s*do\s+you\b/i,
  /^\s*i(?:'m| am)\s+reaching\s+out\b/i,
  /^\s*i\s+wanted\s+to\s+(introduce|reach)\b/i,
  /^\s*(quick\s+)?question\b/i,
  /^\s*hope\s+(this|you)\b/i,
];

/** Pressure language — makes a reply feel owed. */
const OBLIGATION = [
  /\byes\s+or\s+no\b/i,
  /\blet me know either way\b/i,
  /\bpoint me (?:in the right direction|to whoever|to the right)\b/i,
  /\bare you interested\b/i,
  /\bdo you accept referrals\b/i,
  /\bplease let me know if you can\b/i,
  /\bare you available (?:this|next) week\b/i,
  /\bbook a \d+[- ]minute call\b/i,
  /\bwhat do you say\b/i,
];

/**
 * Phrases that manufacture a problem.
 *
 * The recipient runs the business. Telling them what breaks, what it costs, or
 * how their customers behave reads as a salesperson inventing urgency — and it
 * is the single most common failure in this kind of email.
 */
const MANUFACTURED_PAIN = [
  /\b(?:a |any )?(?:failure|breakdown|outage|fault)\b[^.]{0,60}\b(?:costs?|cancels?|loses?|means?)\b/i,
  /\byou(?:'re| are) (?:probably )?(?:losing|missing out|leaving money)\b/i,
  /\bcan cost you\b/i,
  /\bevery (?:day|hour|week) (?:of |that )?(?:downtime|delay)\b/i,
  /\bmost (?:clinics|companies|firms|businesses) (?:struggle|fail|don't|do not)\b/i,
  /\bif (?:it|something) (?:breaks|fails|goes wrong)\b/i,
];

/** Corporate register that gives the game away. */
const ROBOTIC = [
  /\bi hope this (?:email )?finds you well\b/i,
  /\bi trust this email\b/i,
  /\bleverage\b/i,
  /\bsynerg/i,
  /\bvalue proposition\b/i,
  /\bat your earliest convenience\b/i,
  /\breach out to discuss further\b/i,
  /\bcircle back\b/i,
  /\bas per\b/i,
];

const COMMERCIAL = /\b(\d+\s*%|commission|retainer|upfront fee|no exclusivity|fee)\b/i;

/**
 * Social proof the sender cannot possibly have.
 *
 * Caught in testing: given a company with no stored description at all, the
 * model opened with "yours was one of the names that kept coming up on my end".
 * Nothing came up. Handed no material, it invented warmth rather than opening
 * generically — the most damaging kind of fabrication here, because it is
 * flattering, unfalsifiable, and instantly hollow the moment the recipient asks
 * who mentioned them.
 */
const FABRICATED_PROOF = [
  /\b(?:name|names)\b[^.]{0,30}\b(?:kept|keeps|came)\s+(?:coming\s+)?up\b/i,
  /\bcame up (?:a few times|repeatedly|more than once|several times)\b/i,
  /\bheard (?:good|great) things\b/i,
  /\b(?:well|highly) (?:regarded|recommended|reviewed|known)\b/i,
  /\byour reputation\b/i,
  /\beveryone i (?:speak|talk|spoke)\b/i,
  /\bpeople keep mentioning\b/i,
  /\bkeeps? being mentioned\b/i,
  /\bothers have (?:mentioned|recommended)\b/i,
  /\bcomes? highly\b/i,
];

/**
 * Narrating your own browsing.
 *
 * Every one of these came out of a real draft. They are written to sound
 * personal — proof that a human looked rather than a script — and they land as
 * the opposite: the reader pictures a stranger sitting and studying their
 * business before writing to them. "I spent a few minutes on your site" is the
 * clearest case; nobody has ever been pleased to read it.
 */
const SURVEILLANCE = [
  /\bi\s+was\s+(?:looking|going)\s+(?:through|over|at)\b/i,
  /\b(?:ended up|landed)\s+on\s+your\s+(?:site|website|page)\b/i,
  /\b(?:spent|been)\s+(?:a few |some |several )?(?:minutes|time|a while)\s+(?:on|browsing|reading)\b/i,
  /\byour\s+(?:site|website)\s+for\s+a\s+while\b/i,
  /\bi(?:'ve| have)\s+been\s+(?:looking at|researching|reviewing)\s+your\b/i,
  /\bwent\s+through\s+(?:a\s+)?(?:few|number of|bunch of|dozen)\b/i,
];

/**
 * Apologising for having written.
 *
 * Each of these is a reasonable thing to say once, and one of them is exactly
 * what keeps an outside observation honest. The failure is cumulative: measured
 * drafts carried two and three, and the effect is somebody who sounds sorry to
 * be there. So they are counted, not banned.
 */
const HEDGES = [
  /\bthat'?s\s+just\s+(?:what|how)\s+(?:i\s+)?(?:saw|it looked)\b/i,
  /\bfrom\s+(?:the\s+)?outside\b/i,
  // "that's a visitor's view" slipped past a pattern that only matched
  // "visitor's point of view" — the shorter phrasing is the commoner one.
  /\b(?:a\s+)?visitor'?s?\s+(?:view|point of view|perspective)\b/i,
  /\ball\s+i\s+can\s+see\s+is\b/i,
  /\bnot\s+a\s+comment\s+on\b/i,
  /\bi\s+(?:don'?t|do not)\s+know\s+(?:anything|how|what)\b/i,
  /\bno\s+idea\s+how\b/i,
  /\bi'?m\s+guessing\b/i,
  /\bnot\s+a\s+guess\s+about\b/i,
  /\b(?:might|could)\s+be\s+(?:completely\s+)?wrong\b/i,
  /\bas\s+(?:an?\s+)?(?:outsider|visitor)\b/i,
];

/**
 * Sign-offs the writer was handed as examples, then reused word for word.
 *
 * The prompt used to list four "soft closes that work". Five drafts written on
 * the same day closed with two of them verbatim — which is exactly what a
 * template looks like to two owners who compare notes. The list is gone from
 * the prompt; this is what stops it coming back from memory.
 */
const CANNED_CLOSE = [
  /\bif it'?s something you'?d be open to exploring\b/i,
  /\bif it sounds (?:potentially )?relevant\b/i,
  /\bno pressure either way\b/i,
  /\bworth putting on your radar\b/i,
  /\bif you'?re curious,? i can send\b/i,
  /\bhappy to (?:tell you a bit more|have a quick chat)\b/i,
];

/**
 * The stock way of introducing the observation.
 *
 * Three drafts written in the same run all reached for "(the) one thing I
 * noticed from the outside:". The caveat itself is right and stays — what fails
 * is that it arrives in identical words every time, which is the same template
 * tell as the sign-offs. Banning this one construction forces the qualification
 * to be phrased rather than pasted.
 */
const STOCK_OBSERVATION = [
  /\b(?:the\s+)?one\s+thing\s+i\s+noticed\b/i,
  /\bwhat\s+i\s+noticed\s+from\s+(?:the\s+)?outside\b/i,
  /\bfrom\s+the\s+outside(?:,|:)\s+it\s+looks\b/i,
];

/**
 * The model correcting itself mid-email.
 *
 * A real draft signed off "Jasonothers — sorry, Jason Chan". The writer had the
 * recipient's name (Chan Brothers) and the sender's (Jason Chan) in play at
 * once, produced a collision, and then apologised for it inside the email
 * rather than fixing it. It reads as visibly machine-written, and it would have
 * gone out looking exactly like that — nothing checked for it, because it had
 * never occurred to me that it could happen.
 */
const SELF_CORRECTION = [
  /—\s*sorry\b/i,
  /\bsorry,?\s+(?:i mean|that should|make that|typo)/i,
  /\b(?:oops|whoops)\b/i,
  /\bcorrection:/i,
  /\bi meant\b/i,
  /\bthat should (?:read|say|be)\b/i,
];

/**
 * The observation told as a verdict on their website rather than as something
 * that happened to a visitor.
 *
 * The same true fact reads as an accusation or an observation depending on the
 * narrator. "There are twelve different prices on your page" says the owner is
 * confusing and gets defended or deleted; "I couldn't work out which price
 * applied to me" reports what happened to a customer and gets answered.
 *
 * Now that leak findings are sharper than "no enquiry form", this is the line
 * that keeps the email out of the predatory web-agency register — and "you're
 * losing customers" is the sentence every one of those agencies opens with.
 */
const VERDICT_ON_THEIR_SITE = [
  /\byou(?:'re| are)\s+losing\b/i,
  /\byour\s+(?:site|website|page|homepage)\s+(?:has no|lacks|is missing|doesn'?t have)\b/i,
  /\byour\s+(?:booking\s+form|enquiry\s+form|form)\s+is\s+(?:badly|poorly|too far|buried)\b/i,
  /\byour\s+pricing\s+is\s+(?:inconsistent|confusing|unclear|all over)\b/i,
  /\byour\s+(?:homepage|page)\s+is\s+too\s+(?:long|slow|cluttered)\b/i,
  /\bno\s+clear\s+call\s+to\s+action\b/i,
  /\bthere\s+are\s+\d+\s+different\s+prices\s+on\s+your\b/i,
  /\bcosting\s+you\s+(?:leads|customers|business|money)\b/i,
];

/**
 * Apologising for having sent the email.
 *
 * These were written INTO the prompt as good practice, on the reasoning that an
 * easy exit is polite. Read back in a real draft they are the opposite: "if
 * this isn't useful, please just leave it — no reply needed" is a person
 * apologising for existing, and it undoes the offer it follows.
 *
 * A developer who found a real problem on somebody's site and can fix it is
 * sending a useful email. The close should sound like that.
 */
const GRATEFUL = [
  /\bno (?:reply|response) (?:needed|necessary|required)\b/i,
  /\bno need to (?:reply|respond|get back)\b/i,
  /\bleave (?:this|it) where it is\b/i,
  /\bno harm done\b/i,
  /\bsorry to (?:bother|trouble|disturb)\b/i,
  /\bi'?ll leave (?:you|it) (?:to it|there|with you)\b/i,
  /\bfeel free to ignore\b/i,
  /\bdelete this\b/i,
];

/**
 * Manufactured timing.
 *
 * "before the busy purchasing season gets going" opened a real draft and says
 * nothing — it is invented urgency that delays the sentence the reader actually
 * needs, which is what went wrong on their website.
 */
const SEASONAL = [
  /\bbefore the (?:busy|hot|peak|festive|year[- ]end)\b/i,
  /\bahead of the (?:busy|hot|peak|season)\b/i,
  /\b(?:busy|peak|hot) (?:season|months|stretch|period) (?:gets going|starts|kicks off|picks up|is coming)\b/i,
  /\bnow is a good time to\b/i,
  /\bbefore (?:things|it) gets? busy\b/i,
];

const GREETING = /^\s*(hi|hey|hello|dear|good (?:morning|afternoon|evening))\b/i;

const firstSentence = (body: string): string => {
  // Skip the greeting line.
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => !GREETING.test(l));
  const rest = lines.slice(start === -1 ? 0 : start).join(" ");
  return rest.split(/(?<=[.?!])\s/)[0] ?? rest;
};

const paragraphs = (body: string): string[] =>
  body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/**
 * @param opts.minWords the floor below which a draft is too thin. Defaults to
 * 60, which suits an outreach email that has to explain an opportunity. A
 * demand probe passes a much lower floor on purpose: its whole design is one
 * short question, and a 40-word probe is the target rather than a fault. The
 * two checkers disagreed on the first real run and the general one was wrong.
 */
export function checkDraft(subject: string, body: string, opts: { minWords?: number } = {}): Violation[] {
  const v: Violation[] = [];
  const first = firstSentence(body);
  const paras = paragraphs(body);

  // No greeting at all was the single biggest thing making these read as a
  // blast. Every measured draft went straight into "I was looking through
  // aircon firms…" with no "Hi" anywhere — which is what a mail-merge does,
  // because a mail-merge has nobody to greet.
  if (!GREETING.test(body.trimStart())) {
    v.push({
      rule: "no greeting",
      detail: "Starts mid-thought with no greeting, which is what a mail-merge looks like.",
    });
  }

  for (const re of COLD_OPENERS) {
    if (re.test(first)) {
      v.push({ rule: "cold opener", detail: `Opens by asking, not by giving: "${first.slice(0, 70)}"` });
      break;
    }
  }

  for (const re of SURVEILLANCE) {
    const m = body.match(re);
    if (m) {
      v.push({
        rule: "narrates your browsing",
        detail: `"${m[0]}" — meant to read as personal, lands as somebody studying their business.`,
      });
      break;
    }
  }

  const hedges = HEDGES.filter((re) => re.test(body));
  if (hedges.length > 1) {
    v.push({
      rule: "over-hedged",
      detail:
        `${hedges.length} separate disclaimers: ${hedges.map((re) => `"${body.match(re)![0]}"`).join(", ")}. ` +
        `One keeps it honest; several sound sorry to have written.`,
    });
  }

  for (const re of CANNED_CLOSE) {
    const m = body.match(re);
    if (m) {
      v.push({
        rule: "stock close",
        detail: `"${m[0]}" is a sign-off every other draft also used. Write this one fresh.`,
      });
      break;
    }
  }

  for (const re of GRATEFUL) {
    const m = body.match(re);
    if (m) {
      v.push({
        rule: "apologetic close",
        detail: `"${m[0]}" reads as begging. End on the offer of a call and stop.`,
      });
      break;
    }
  }

  for (const re of SEASONAL) {
    const m = body.match(re);
    if (m) {
      v.push({
        rule: "invented urgency",
        detail: `"${m[0]}" is manufactured timing, and it delays the sentence they need to read.`,
      });
      break;
    }
  }

  for (const re of VERDICT_ON_THEIR_SITE) {
    const m = body.match(re);
    if (m) {
      v.push({
        rule: "verdict on their site",
        detail:
          `"${m[0]}" judges their website. Say what happened to you as a visitor instead — ` +
          `"I couldn't work out which price applied to me", not "your pricing is confusing".`,
      });
      break;
    }
  }

  for (const re of SELF_CORRECTION) {
    const m = body.match(re);
    if (m) {
      v.push({
        rule: "self-correction",
        detail: `"${m[0]}" — the draft corrects itself mid-email, which reads as machine-written.`,
      });
      break;
    }
  }

  for (const re of STOCK_OBSERVATION) {
    const m = body.match(re);
    if (m) {
      v.push({
        rule: "stock observation",
        detail: `"${m[0]}" opened three drafts in a row word for word. Keep the caveat, phrase it yourself.`,
      });
      break;
    }
  }

  if (/\?/.test(first) && /^(could|can|would|do|are|is)\b/i.test(first.trim())) {
    v.push({ rule: "opens with a request", detail: "The first sentence asks the recipient to do something." });
  }

  for (const re of OBLIGATION) {
    const m = body.match(re);
    if (m) { v.push({ rule: "pressure", detail: `Makes a reply feel owed: "${m[0]}"` }); break; }
  }

  for (const re of MANUFACTURED_PAIN) {
    const m = body.match(re);
    if (m) { v.push({ rule: "manufactured pain", detail: `Invents a problem or lectures them: "${m[0]}"` }); break; }
  }

  for (const re of FABRICATED_PROOF) {
    const m = body.match(re);
    if (m) {
      v.push({
        rule: "fabricated social proof",
        detail: `Claims something unverifiable: "${m[0]}". Nobody mentioned them.`,
      });
      break;
    }
  }

  for (const re of ROBOTIC) {
    const m = body.match(re);
    if (m) { v.push({ rule: "corporate register", detail: `Reads as a template: "${m[0]}"` }); break; }
  }

  // Commercial terms must not be the reason for the email.
  const firstTwo = paras.slice(0, 2).join(" ");
  if (COMMERCIAL.test(firstTwo)) {
    v.push({ rule: "leads with money", detail: "Commission or fees appear before the opportunity is established." });
  }

  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 190) v.push({ rule: "too long", detail: `${words} words; target 100-160.` });
  const floor = opts.minWords ?? 60;
  if (words < floor) v.push({ rule: "too short", detail: `${words} words; below the ${floor}-word floor for this kind of email.` });

  // Subject lines that read like a campaign.
  if (/\b(\d{1,3}%|SGD|\$\d|free|deal|offer|buying|Feb|Jan|Q[1-4])\b/i.test(subject)) {
    v.push({ rule: "campaign subject", detail: `Subject reads like an ad: "${subject}"` });
  }
  if (subject.length > 60) {
    v.push({ rule: "campaign subject", detail: "Subject is too long to feel personal." });
  }

  return v;
}

/** One line per violation, for feeding back into a regeneration. */
export const violationBrief = (v: Violation[]) =>
  v.map((x) => `- ${x.rule}: ${x.detail}`).join("\n");


// Fabrication checks live in quality-names.ts — re-exported so callers have
// one import for every check.
export { checkInventedNames, checkPlaceholders } from "./quality-names";

// Probe-specific checks live in quality-probe.ts.
export { checkProbe } from "./quality-probe";
