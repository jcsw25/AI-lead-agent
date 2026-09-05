import type { Violation } from "@/lib/outreach/quality";

/**
 * What an acquisition enquiry must never say.
 *
 * These are not style preferences. Each pattern below is a claim that is either
 * false when we make it, or a known signature of a predatory approach — and
 * both kinds end the conversation permanently with an owner who might otherwise
 * have talked.
 *
 * The prompt already forbids all of it. This exists because a prompt is a
 * request and a checker is a guarantee, and the cost of one bad email here is
 * not a wasted send: it is a person concluding that somebody is circling their
 * life's work.
 */

/** Money we have not agreed and numbers we have not seen. */
const PRICE_CLAIM: Array<[RegExp, string]> = [
  [/\b(?:S?\$|SGD|USD)\s?\d[\d,.]*\s?(?:k|m|million|mil)?\b/i, "states a figure"],
  [/\b\d+(?:\.\d+)?\s?x\s+(?:ebitda|earnings|profit|revenue|multiple)/i, "states a multiple"],
  [/\b(?:valu(?:e|ation|ing)|worth|offer(?:ing)? you|pay you|price of)\b/i, "puts a value on the business"],
  [/\bfair (?:price|value|offer)\b/i, "implies a price has been worked out"],
];

/** Backing, track record and capital we were not told we have. */
const UNBACKED_CLAIM: Array<[RegExp, string]> = [
  [/\b(?:we|i) (?:have|'ve got|has) (?:capital|funding|funds|cash|backing|investors)\b/i, "claims funding"],
  [/\bfully funded\b|\bfunds? (?:are )?(?:ready|available|in place)\b/i, "claims funds are in place"],
  [/\b(?:acquired|bought|own) (?:\d+|several|multiple|a number of) (?:businesses|companies)\b/i, "claims a track record"],
  [/\bour (?:portfolio|fund|group|investors|partners)\b/i, "implies a firm behind the sender"],
  [/\bon behalf of (?:a|our|my) (?:client|buyer|investor|group)\b/i, "claims to represent a buyer"],
  [/\bpre-?approved\b|\bproof of funds\b/i, "claims financing status"],
];

/**
 * The predatory register.
 *
 * Every one of these implies the owner is in trouble or running out of time.
 * They are the tells that make an approach read as circling, and they are what
 * gets a sender blocked rather than answered.
 */
const PREDATORY: Array<[RegExp, string]> = [
  [/\b(?:struggl|declin|dying|failing|stagnant|going under|tough time|difficult (?:market|period))/i,
   "suggests the business is in trouble"],
  [/\b(?:retire|retirement|getting on|slowing down|winding down|step back|at your age|later years)\b/i,
   "speculates about the owner's life stage"],
  [/\bhaven'?t (?:updated|touched|posted|changed)\b|\blooks? (?:dated|outdated|neglected)\b/i,
   "uses a weakness in their business as the opening"],
  [/\bbefore (?:it'?s too late|things get worse|the market)\b/i, "manufactures urgency about their position"],
  [/\bexit (?:strategy|plan)\b/i, "presumes they are planning to leave"],
  [/\bdon'?t tell\b|\bbetween (?:us|you and me)\b|\bkeep this (?:quiet|between)\b/i,
   "asks them to keep it from their own people"],
];

/** Pressure. They owe us nothing, least of all a reply. */
const PRESSURE: Array<[RegExp, string]> = [
  [/\b(?:this week|by friday|by the end of|deadline|limited time|closing soon|act (?:fast|now))\b/i,
   "sets a deadline"],
  [/\b(?:only|just) (?:looking at|considering) (?:a few|two|three|\d+)\b/i, "implies competition for their attention"],
  [/\bfollow(?:ing)? up (?:again|next week)\b|\bi'?ll (?:call|ring|chase) you\b/i, "promises to chase"],
  [/\blast chance\b|\bfinal (?:email|attempt)\b/i, "manufactures scarcity"],
];

/** The rung asked for must be the rung they have reached. */
const RUNG_ASK: Record<string, RegExp[]> = {
  OPEN_TO_SELLING: [
    /\b(?:p&l|profit and loss|balance sheet|financials?|ebitda|turnover figures|tax returns|management accounts)\b/i,
    /\bsign (?:an? )?nda\b/i,
  ],
  NDA: [/\b(?:p&l|profit and loss|balance sheet|send (?:me )?(?:your )?financials?|ebitda figures)\b/i],
  FINANCIALS: [],
};

const scan = (text: string, rules: Array<[RegExp, string]>, rule: string): Violation[] =>
  rules
    .filter(([re]) => re.test(text))
    .map(([re, detail]) => ({ rule, detail: `${detail} — matched ${String(re).slice(0, 60)}` }));

/**
 * Check one acquisition enquiry.
 *
 * `statedFacts` are figures the LISTING itself published. A price in the body
 * is allowed only when it is one of those and the listing is where it came
 * from — quoting an owner's own advertised asking price back to them is normal;
 * naming any other number is inventing one.
 */
export function checkAcquisitionEnquiry(
  subject: string,
  body: string,
  opts: {
    ask: "OPEN_TO_SELLING" | "NDA" | "FINANCIALS";
    origin: "LISTED" | "PROPRIETARY";
    statedFacts?: string[];
  },
): Violation[] {
  const text = `${subject}\n${body}`;
  const v: Violation[] = [];

  // Figures are only permissible where the listing published them and the
  // number in the email is one of those. A PROPRIETARY approach has no
  // published figures at all, so any number is invented by definition.
  const published = (opts.statedFacts ?? []).join(" ");
  const priceHits = PRICE_CLAIM.filter(([re]) => re.test(text));
  for (const [re, detail] of priceHits) {
    const m = text.match(re)?.[0] ?? "";
    const digits = m.replace(/[^0-9]/g, "");
    const quotedFromListing =
      opts.origin === "LISTED" && digits.length >= 3 && published.replace(/[^0-9]/g, "").includes(digits);
    if (!quotedFromListing) {
      v.push({ rule: "no-invented-figures", detail: `${detail}: "${m.trim()}" is not a figure they published` });
    }
  }

  v.push(...scan(text, UNBACKED_CLAIM, "no-unbacked-claims"));
  v.push(...scan(text, PREDATORY, "not-predatory"));
  v.push(...scan(text, PRESSURE, "no-pressure"));

  for (const re of RUNG_ASK[opts.ask] ?? []) {
    if (re.test(text)) {
      v.push({
        rule: "one-rung-at-a-time",
        detail: `asks for something beyond ${opts.ask} — they have not got there yet`,
      });
    }
  }

  // A no has to be offered, and it has to be offered in the email rather than
  // implied by tone. Without it the recipient's only ways out are to reply or
  // to feel chased.
  const easyNo =
    /\b(?:no (?:is|is a)? ?(?:fine|okay|ok|perfectly)|not interested,? ?(?:that'?s|no) (?:fine|problem)|won'?t (?:chase|follow up|contact you again)|that'?s (?:a )?(?:fine|perfectly good) (?:answer|reply)|no (?:problem|worries) (?:at all|if not)|if (?:the answer'?s|it'?s a) no|leave (?:it|you) (?:there|be)|happy to leave it)\b/i;
  if (!easyNo.test(body)) {
    v.push({ rule: "easy-no", detail: "does not tell them a no is a fine answer and will not be chased" });
  }

  // A PROPRIETARY owner advertised nothing. An email that skips saying so reads
  // as though we believe they are selling, which is presumptuous and false.
  if (opts.origin === "PROPRIETARY") {
    const acknowledges =
      /\b(?:out of the blue|unsolicited|you (?:haven'?t|have not) advertised|not (?:for sale|on the market)|may(?:be)? (?:completely )?the wrong time|apolog(?:ies|ise) for the cold|cold (?:email|approach)|unprompted|nobody asked)\b/i;
    if (!acknowledges.test(body)) {
      v.push({
        rule: "acknowledge-cold",
        detail: "does not acknowledge they never advertised — reads as though we assume they are selling",
      });
    }
  }

  // One question. Two turns a respectful enquiry into an interrogation.
  const questions = (body.match(/\?/g) ?? []).length;
  if (questions > 1) {
    v.push({ rule: "one-question", detail: `asks ${questions} questions; one is the limit` });
  }
  if (questions === 0) {
    v.push({ rule: "one-question", detail: "asks nothing, so there is nothing for them to answer" });
  }

  const words = body.split(/\s+/).filter(Boolean).length;
  if (opts.ask === "OPEN_TO_SELLING" && words > 160) {
    v.push({ rule: "length", detail: `${words} words; a first approach over ~120 reads as a pitch` });
  }

  return v;
}
