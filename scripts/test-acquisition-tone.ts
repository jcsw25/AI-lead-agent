/**
 * Does the acquisition gate catch the emails that would do real damage?
 *
 *   npx tsx scripts/test-acquisition-tone.ts
 *
 * Free — no model calls. Every BAD case below is a plausible thing a model
 * writes when asked to approach a business owner about selling, and every one
 * of them is either a claim that is false when we make it or a signature of a
 * predatory approach. The prompt forbids all of them; this is what makes that
 * a guarantee rather than a request.
 *
 * The GOOD cases matter just as much: a checker that rejects everything is not
 * strict, it is broken, and it fails silently by making every draft look bad.
 */
import { checkAcquisitionEnquiry } from "@/lib/outreach/quality-acquisition";

type Case = {
  name: string;
  subject: string;
  body: string;
  ask?: "OPEN_TO_SELLING" | "NDA" | "FINANCIALS";
  origin?: "LISTED" | "PROPRIETARY";
  statedFacts?: string[];
  /** The rule that must fire. Empty means the draft must pass clean. */
  expect: string | null;
};

const OK_TAIL = "If the answer's no, that's a perfectly good answer and I won't chase it.\n\nJason";
const COLD_OPEN = "This is out of the blue, so I'll be direct.";

const CASES: Case[] = [
  {
    name: "clean proprietary approach",
    subject: "Would you ever consider selling?",
    body: `Hi there,\n\n${COLD_OPEN} I'm Jason, and I'm looking to buy and run an aircon servicing business here in Singapore.\n\nYou haven't advertised anything, so this may be entirely the wrong time — but would you ever consider selling?\n\n${OK_TAIL}`,
    expect: null,
  },
  {
    name: "clean listed approach quoting their own advertised price",
    subject: "Your listing on BusinessForSale.sg",
    body: `Hi there,\n\nI saw your listing on BusinessForSale.sg — the aircon business at SGD 650,000. I'm Jason, buying to run it myself rather than for a client.\n\nIs it still available?\n\n${OK_TAIL}`,
    origin: "LISTED",
    statedFacts: ["Asking price as advertised: SGD 650,000"],
    expect: null,
  },
  {
    name: "invents a price nobody published",
    subject: "Interested in your business",
    body: `Hi there,\n\n${COLD_OPEN} I'd be looking at somewhere around SGD 800,000 for a business like yours.\n\nWould you consider it?\n\n${OK_TAIL}`,
    expect: "no-invented-figures",
  },
  {
    name: "offers a multiple",
    subject: "A question",
    body: `Hi there,\n\n${COLD_OPEN} I typically pay 3.5x EBITDA for businesses in this space.\n\nWould you ever consider selling?\n\n${OK_TAIL}`,
    expect: "no-invented-figures",
  },
  {
    name: "claims funding it does not have",
    subject: "Would you consider selling?",
    body: `Hi there,\n\n${COLD_OPEN} We have capital ready to deploy and have acquired 12 businesses in this sector.\n\nWould you ever consider selling?\n\n${OK_TAIL}`,
    expect: "no-unbacked-claims",
  },
  {
    name: "claims to represent a buyer",
    subject: "Enquiry",
    body: `Hi there,\n\n${COLD_OPEN} I'm writing on behalf of a client who is looking to acquire in this space.\n\nWould you consider a conversation?\n\n${OK_TAIL}`,
    expect: "no-unbacked-claims",
  },
  {
    name: "implies the business is struggling — the predatory tell",
    subject: "Thinking about the future?",
    body: `Hi there,\n\n${COLD_OPEN} I know it's a difficult market for aircon firms right now and many are struggling.\n\nWould you ever consider selling?\n\n${OK_TAIL}`,
    expect: "not-predatory",
  },
  {
    name: "speculates that the owner wants to retire",
    subject: "A question about the business",
    body: `Hi there,\n\n${COLD_OPEN} If you're thinking about retirement or slowing down, I'd be interested.\n\nWould you consider selling?\n\n${OK_TAIL}`,
    expect: "not-predatory",
  },
  {
    name: "uses their neglected website as the opening",
    subject: "Noticed something",
    body: `Hi there,\n\n${COLD_OPEN} I noticed you haven't updated the site in a while and it looks dated.\n\nWould you ever consider selling?\n\n${OK_TAIL}`,
    expect: "not-predatory",
  },
  {
    name: "asks them to keep it from their own people",
    subject: "Confidential",
    body: `Hi there,\n\n${COLD_OPEN} Let's keep this between us for now.\n\nWould you ever consider selling?\n\n${OK_TAIL}`,
    expect: "not-predatory",
  },
  {
    name: "sets a deadline",
    subject: "Would you consider selling?",
    body: `Hi there,\n\n${COLD_OPEN} I'd need to hear back by Friday as we're only looking at three businesses.\n\nWould you ever consider selling?\n\n${OK_TAIL}`,
    expect: "no-pressure",
  },
  {
    name: "promises to chase",
    subject: "Quick one",
    body: `Hi there,\n\n${COLD_OPEN} I'll call you next week to follow up.\n\nWould you ever consider selling?\n\n${OK_TAIL}`,
    expect: "no-pressure",
  },
  {
    name: "asks for financials from someone who has said nothing",
    subject: "Would you consider selling?",
    body: `Hi there,\n\n${COLD_OPEN} Could you send over your P&L for the last three years?\n\nWould you ever consider selling?\n\n${OK_TAIL}`,
    expect: "one-rung-at-a-time",
  },
  {
    name: "no easy out offered",
    subject: "Would you ever consider selling?",
    body: `Hi there,\n\n${COLD_OPEN} I'm Jason and I'm looking to buy an aircon servicing business in Singapore.\n\nWould you ever consider selling?\n\nJason`,
    expect: "easy-no",
  },
  {
    name: "proprietary approach that pretends they advertised",
    subject: "Your business",
    body: `Hi there,\n\nI'm Jason and I'm looking to buy an aircon servicing business in Singapore. Yours looks like a good fit for what I'm after.\n\nWould you ever consider selling?\n\n${OK_TAIL}`,
    expect: "acknowledge-cold",
  },
  {
    name: "interrogates with three questions",
    subject: "Would you consider selling?",
    body: `Hi there,\n\n${COLD_OPEN} Would you ever consider selling? How many staff do you have? What's your turnover?\n\n${OK_TAIL}`,
    expect: "one-question",
  },
];

let pass = 0;
let fail = 0;

for (const c of CASES) {
  const v = checkAcquisitionEnquiry(c.subject, c.body, {
    ask: c.ask ?? "OPEN_TO_SELLING",
    origin: c.origin ?? "PROPRIETARY",
    statedFacts: c.statedFacts,
  });
  const rules = v.map((x) => x.rule);

  const ok = c.expect === null ? v.length === 0 : rules.includes(c.expect);
  if (ok) {
    pass++;
    console.log(`ok    ${c.name}`);
  } else {
    fail++;
    console.log(`FAIL  ${c.name}`);
    console.log(`      expected ${c.expect ?? "a clean pass"}, got ${rules.length ? rules.join(", ") : "nothing"}`);
    for (const x of v) console.log(`        ${x.rule}: ${x.detail.slice(0, 100)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
