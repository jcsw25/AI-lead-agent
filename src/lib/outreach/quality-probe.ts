import type { Violation } from "./quality";

/**
 * Checks specific to the demand probe.
 *
 * The probe has one job — get an answer — and exactly one way to fail: by
 * becoming a pitch. The general tone checks do not catch that, because a pitch
 * can be perfectly warm, perfectly short, and still be a pitch.
 *
 * These rules are enforced here rather than trusted to the prompt for the
 * reason established three times on this project: a prompt is a request. The
 * supplier writer kept its cold opener through two rewrites; the buyer writer
 * invented a company name while passing every tone check. Anything that can be
 * checked mechanically, is.
 */

/** Language that means an offer is being made. There is nothing to offer yet. */
const SELLING = [
  /\bI work with\b/i,
  /\bwe work with\b/i,
  /\ba (?:client|company|supplier|contractor|firm) (?:of mine|I know|we know)\b/i,
  /\bI(?:'d| would) (?:like to )?(?:introduce|connect|put you in touch)\b/i,
  /\bI can (?:introduce|connect|recommend|put you)\b/i,
  /\bhappy to (?:introduce|connect|recommend|send (?:them|their|over their))\b/i,
  /\bwe (?:provide|offer|supply|specialise|specialize)\b/i,
  /\bour (?:service|team|company|clients)\b/i,
  /\bwould you (?:be interested|like)\b/i,
];

/** Commercial terms. There is no deal to price. */
const COMMERCIAL = [
  /\b\d+\s*%/,
  /\bcommission\b/i,
  /\bretainer\b/i,
  /\bno (?:upfront|up front) fee\b/i,
  /\bSGD\s*[\d,]/i,
  /\bquote\b/i,
  /\bpricing\b/i,
];

/** Obligation. They owe nothing, least of all a reply. */
const PRESSURE = [
  /\byes or no\b/i,
  /\blet me know either way\b/i,
  /\bare you interested\b/i,
  /\bcan you point me\b/i,
  /\bplease (?:reply|respond|confirm)\b/i,
  /\blooking forward to (?:your|hearing)\b/i,
];

/**
 * @param allowedNames the recipient and the sender's own business. Any other
 * company named means a supplier has been invented.
 */
export function checkProbe(
  subject: string,
  body: string,
  theQuestion: string,
  allowedNames: string[],
): Violation[] {
  const v: Violation[] = [];

  for (const re of SELLING) {
    const m = body.match(re);
    if (m) {
      v.push({
        rule: "probe is selling",
        detail: `"${m[0]}" makes an offer. A probe asks a question and offers nothing — there is no supplier yet.`,
      });
      break;
    }
  }

  for (const re of COMMERCIAL) {
    const m = body.match(re);
    if (m) {
      v.push({ rule: "commercial terms in a probe", detail: `"${m[0]}" prices a deal that does not exist yet.` });
      break;
    }
  }

  for (const re of PRESSURE) {
    const m = body.match(re);
    if (m) {
      v.push({ rule: "pressure", detail: `"${m[0]}" makes a reply feel owed.` });
      break;
    }
  }

  // Exactly one question. Two questions halve the chance of an answer to either.
  const questions = (body.match(/\?/g) ?? []).length;
  if (questions === 0) {
    v.push({ rule: "no question", detail: "A probe with no question is a pitch." });
  } else if (questions > 1) {
    v.push({
      rule: "more than one question",
      detail: `${questions} questions. Ask one — every extra question lowers the odds of an answer to any of them.`,
    });
  }

  // The extracted question must actually appear in the body.
  if (theQuestion && !body.toLowerCase().includes(theQuestion.toLowerCase().slice(0, 25))) {
    v.push({ rule: "question mismatch", detail: "The stated question does not appear in the email body." });
  }

  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 110) {
    v.push({
      rule: "too long for a probe",
      detail: `${words} words. Under 80 — a long email asking a small question reads as a pitch wearing a question mark.`,
    });
  }

  if (subject.length > 55) {
    v.push({ rule: "subject too long", detail: `Subject is ${subject.length} characters; keep it under 50.` });
  }
  if (/\b(free|offer|save|best|deal|opportunity|introduc)/i.test(subject)) {
    v.push({ rule: "subject sells", detail: `"${subject}" reads as marketing rather than a question.` });
  }

  return v;
}
