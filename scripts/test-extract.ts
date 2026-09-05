/**
 * Does the need extractor hold under replies designed to break it?
 *
 *   npx tsx scripts/test-extract.ts
 *
 * The extractor is the only place in the pipeline where a model's output
 * becomes a fact that a third party is later told. Everything downstream —
 * which supplier gets recruited, what they are told a buyer said — rests on it
 * being right, so it gets adversarial cases rather than happy-path ones.
 *
 * Nothing is written to the database. Each case runs the agent against a
 * fabricated reply and checks the verdict and the verbatim gate directly.
 */
import { runAgent } from "@/agents/runtime";
import { needExtractor, quoteIsReal } from "@/agents/need-extractor";
import { db } from "@/lib/db";

type Case = {
  name: string;
  reply: string;
  category: string;
  expect: {
    hasNeed?: boolean;
    urgency?: string;
    incumbent?: string | null;
    /** They referred to a supplier without naming one — the field must stay empty. */
    incumbentIsNull?: boolean;
    wantsNoContact?: boolean;
    answered?: boolean;
    otherNeed?: boolean;
  };
};

const CASES: Case[] = [
  {
    name: "plain yes with a date",
    category: "aircon servicing",
    reply:
      "Hi, yes we are actually looking at this. Our current contract with Cool Breeze ends in November and " +
      "we have not been happy with their response times. Send me what you have.",
    expect: { hasNeed: true, urgency: "THIS_QUARTER", incumbent: "Cool Breeze", answered: true },
  },
  {
    name: "polite no — must not become a need",
    category: "aircon servicing",
    reply: "Thanks for reaching out. We're all set on that front, we've used the same guys for years. All the best.",
    // incumbent null on purpose: "the same guys" is not a name, and this field
    // gets quoted to a supplier. "They currently use the same guys" reads as
    // something we made up, because it is not something anyone can check.
    expect: { hasNeed: false, answered: true, incumbentIsNull: true },
  },
  {
    name: "warm but says nothing — the trap",
    category: "cleaning services",
    reply: "Hi! Thanks for the note, sounds interesting. Hope you're having a good week.",
    // The danger: friendly words with no content. A model looking for an opening
    // reads "sounds interesting" as buying intent. It is not one.
    expect: { hasNeed: false },
  },
  {
    name: "out of office",
    category: "aircon servicing",
    reply: "I am currently out of the office until 15 September with limited access to email.",
    expect: { answered: false, hasNeed: false },
  },
  {
    name: "politely asks to stop",
    category: "aircon servicing",
    reply: "Appreciate the note but please take us off your list, we don't take cold approaches. Thanks.",
    expect: { wantsNoContact: true },
  },
  {
    name: "no to what we asked, yes to something else",
    category: "aircon servicing",
    reply:
      "Aircon we handle in house. But if you know anyone who does pest control we are looking, our current " +
      "one keeps missing appointments.",
    expect: { hasNeed: false, otherNeed: true },
  },
  {
    name: "urgent, with a number",
    category: "aircon servicing",
    reply:
      "Actually yes — two of our units are down and we need someone this week. Budget is around $4,000 for now. " +
      "Can you call me at 9123 4567?",
    expect: { hasNeed: true, urgency: "NOW", answered: true },
  },
];

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

let pass = 0;
let fail = 0;
let cost = 0;

for (const c of CASES) {
  const run = await runAgent(
    needExtractor,
    {
      ourQuestion: `whether they currently need ${c.category}, and who they use today`,
      category: c.category,
      companyName: "Test Company Pte Ltd",
      replyText: c.reply,
    },
    { businessId: biz.id },
  );
  cost += run.costUsd;
  const x = run.output;

  const problems: string[] = [];

  // The gate matters more than any single field: an unverifiable quote voids
  // the whole extraction, so it is checked on every case, not just the ones
  // where a quote is expected.
  if (!quoteIsReal(x.verbatim, c.reply)) {
    problems.push(`FABRICATED QUOTE: "${x.verbatim}" is not in the reply`);
  }
  if (c.expect.hasNeed !== undefined && x.hasNeedInThisCategory !== c.expect.hasNeed) {
    problems.push(`hasNeed ${x.hasNeedInThisCategory}, expected ${c.expect.hasNeed}`);
  }
  if (c.expect.urgency && x.urgency !== c.expect.urgency) {
    problems.push(`urgency ${x.urgency}, expected ${c.expect.urgency}`);
  }
  if (c.expect.incumbent && !(x.incumbent ?? "").toLowerCase().includes(c.expect.incumbent.toLowerCase())) {
    problems.push(`incumbent "${x.incumbent}", expected to name ${c.expect.incumbent}`);
  }
  if (c.expect.incumbentIsNull && x.incumbent) {
    problems.push(`incumbent "${x.incumbent}" — they named nobody, so this must be null`);
  }
  if (c.expect.wantsNoContact !== undefined && x.wantsNoContact !== c.expect.wantsNoContact) {
    problems.push(`wantsNoContact ${x.wantsNoContact}, expected ${c.expect.wantsNoContact}`);
  }
  if (c.expect.answered !== undefined && x.answeredTheQuestion !== c.expect.answered) {
    problems.push(`answeredTheQuestion ${x.answeredTheQuestion}, expected ${c.expect.answered}`);
  }
  if (c.expect.otherNeed && !x.otherNeed) {
    problems.push("missed the need they raised themselves");
  }

  if (problems.length) {
    fail++;
    console.log(`\nFAIL  ${c.name}`);
    for (const p of problems) console.log(`      ${p}`);
    console.log(`      reasoning: ${x.reasoning.slice(0, 160)}`);
  } else {
    pass++;
    const detail = [
      x.hasNeedInThisCategory ? `need (${x.urgency})` : "no need",
      x.incumbent ? `uses ${x.incumbent}` : null,
      x.budgetHint ? `budget ${x.budgetHint}` : null,
      x.otherNeed ? `also wants ${x.otherNeed}` : null,
      x.wantsNoContact ? "STOP" : null,
    ].filter(Boolean).join(" · ");
    console.log(`pass  ${c.name.padEnd(34)} ${detail}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed · $${cost.toFixed(4)}`);
await db.$disconnect();
process.exit(fail ? 1 : 0);
