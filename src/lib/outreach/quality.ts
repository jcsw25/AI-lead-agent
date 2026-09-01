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

const firstSentence = (body: string): string => {
  // Skip the greeting line.
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => !/^(hi|hey|hello|dear)\b/i.test(l));
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

  for (const re of COLD_OPENERS) {
    if (re.test(first)) {
      v.push({ rule: "cold opener", detail: `Opens by asking, not by giving: "${first.slice(0, 70)}"` });
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
