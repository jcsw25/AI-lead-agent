import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";
import { checkDraft, violationBrief } from "@/lib/outreach/quality";

/**
 * OUTREACH WRITER
 *
 * Writes the cold email for one match. When the product belongs to a partner
 * rather than the tenant, the email is an INTRODUCTION - it names the supplier
 * and offers to connect the two sides. That framing is the commission model
 * made visible, and hiding it would be both worse copy and worse ethics.
 */

const Email = z.object({
  subject: z.string(),
  body: z.string(),
});

const Input = z.object({
  senderName: z.string(),
  senderBusiness: z.string(),
  contactName: z.string(),
  contactRole: z.string(),
  companyName: z.string(),
  companyContext: z.string(),
  buyingTrigger: z.string(),
  timingWindow: z.string().optional(),
  productName: z.string(),
  productDescription: z.string().optional(),
  priceRange: z.string().optional(),
  supplierName: z.string(),
  isBrokered: z.boolean(),
  isService: z.boolean(),
  observedPain: z.string().optional(),
  firstAsk: z.string().optional(),
  rationale: z.string(),
  /** Only VERIFIED facts reach the writer — see ADR-003. */
  verifiedFacts: z.array(z.string()),
});

const Output = z.object({
  initial: Email,
  followUps: z.array(Email.extend({ delayDays: z.number() })).max(2),
  /** Every factual claim about the prospect, so it can be checked post-hoc. */
  claimsMade: z.array(z.string()),
});

const SYSTEM = `You write a short, personal email to a business owner because you think you
may have something useful for them.

You are not selling. You are starting a conversation.

WHO IS READING

Someone who runs a small firm and is good at their trade. They get a dozen automated
pitches a week and delete all of them. They do not need anything explained to them about
their own business, their own customers, or their own risks. What makes them read on is
the sense that a real person looked at their company specifically.

STRUCTURE — four short paragraphs

1. HUMAN OPENING. How you came across them, plus at most ONE specific verified observation.
   If you have an observedPain, mention it plainly and NEUTRALLY, as something you noticed
   from outside — never as a diagnosis or a problem you are announcing to them.
2. WHY YOU ARE WRITING. What you have and why it might be relevant to them.
3. THE ARRANGEMENT, briefly and lightly. One sentence, near the end.
4. SOFT CLOSE that is easy to ignore.

HARD RULES

- THE FIRST SENTENCE MUST NOT ASK FOR ANYTHING. Never open with "Could you point me to",
  "Can you", "Are you the person", "I'm reaching out", "I wanted to introduce", "Quick
  question", or "I hope this finds you well".

- NEVER EXPLAIN THEIR BUSINESS TO THEM, AND NEVER INVENT A PROBLEM. Do not tell them what
  their customers do, what revenue they are losing, what happens when something fails, or
  how their industry works. "If your quarterly services depend on the customer remembering
  to call, some of that revenue never gets billed" is exactly the sentence that gets an
  email deleted: it is a guess dressed as insight, and they know their own billing.

- NEVER CREATE OBLIGATION. Banned: "yes or no", "let me know either way", "are you
  interested", "can you point me in the right direction", "worth a 15-minute call",
  "book a call", "are you available this week".

- DO NOT LEAD WITH MONEY, and do not quote a project price cold. You have scoped nothing.
  A range may appear once, late, as context only. Never in the subject line.

- ONE OBSERVATION, NOT FIVE. Listing everything you know reads like scraped data.

- Every factual claim about them must come from verifiedFacts or observedPain. If both are
  thin, open with how you came across them and make NO claims. Never invent social proof —
  no "your name came up", no "I've heard good things". List every claim in claimsMade.

- When isBrokered is true you are making an INTRODUCTION, not selling your own product.
  Say plainly that you work with the supplier. Do not imply the product is yours.

WHEN isService IS TRUE

You are offering a conversation, not a build. Mention the symptom you observed from
outside and say plainly that it is an outside observation — the honesty is what makes it
credible. Do not claim to know their systems, their stack, or their internal processes.
Do not quote the build.

SOFT CLOSES THAT WORK

"If it's something you'd be open to exploring, happy to tell you a bit more."
"If it sounds potentially relevant, happy to have a quick chat."
"No pressure either way, just thought it might be worth putting on your radar."
"If you're curious, I can send over a bit more detail."

SUBJECT LINES

Curious and personal, never a campaign. Under 55 characters. Never a price, a percentage,
a month, or a market claim.

FOLLOW-UPS

Two maximum, each adding something new. Never "just bumping this up".

VOICE AND LENGTH

Write like a person. Contractions. Plain sentences. 100 to 160 words.`;

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "OUTREACH",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) => `From: ${i.senderName} at ${i.senderBusiness}
To: ${i.contactName}, ${i.contactRole} at ${i.companyName}

Company context: ${i.companyContext}
Why now: ${i.buyingTrigger}${i.timingWindow ? `\nTiming: ${i.timingWindow}` : ""}

Pitching: ${i.productName}${i.priceRange ? ` (${i.priceRange})` : ""}
${i.productDescription ?? ""}
Supplier: ${i.supplierName}${i.isBrokered ? " — PARTNER, this is an introduction" : " — our own product"}
Type: ${i.isService ? "SERVICE — ask for a diagnostic call, do not quote a build" : "PRODUCT"}
${i.observedPain ? `Symptom observed: ${i.observedPain}` : ""}
${i.firstAsk ? `Suggested ask: ${i.firstAsk}` : ""}
Why this for them: ${i.rationale}

Verified facts you may reference (${i.verifiedFacts.length}):
${i.verifiedFacts.length ? i.verifiedFacts.map((f) => `- ${f}`).join("\n") : "(none — make no factual claims about this company)"}`,
  mock: (i) => {
    const trim = (s: string) => s.replace(/\s*[.;]+\s*$/, "");
    const first = i.contactName.split(" ")[0];
    const sig = i.senderName === i.senderBusiness ? i.senderName : `${i.senderName}\n${i.senderBusiness}`;
    return {
    initial: i.isService
      ? {
          subject: `${trim(i.observedPain ?? "Manual process load")} at ${i.companyName}`,
          body: `Hi ${first},

${i.observedPain ? `From the outside it looks like ${trim(i.observedPain).toLowerCase()}. ` : ""}In my experience that usually means someone is moving data between systems by hand — expensive, and it gets worse as you grow.

I work with ${i.supplierName}, who fix exactly that. I don't know your systems, so I'd rather ask than assume.

${trim(i.firstAsk ?? "A 20-minute call to find out where the manual load actually sits")} — worth it?

${sig}

[SIMULATED DRAFT — generated without a model. Add ANTHROPIC_API_KEY for real copy.]`,
        }
      : {
      subject: `${i.productName} for ${i.companyName}`,
      body: `Hi ${first},

${i.isBrokered ? `We work with ${i.supplierName}, who supply ${i.productName.toLowerCase()}. ` : ""}${trim(i.buyingTrigger)} — which usually means ${i.contactRole.toLowerCase()}s start sourcing around now.

${trim(i.productDescription ?? i.productName)}${i.priceRange ? `, ${i.priceRange}` : ""}.

Worth a 15-minute call${i.isBrokered ? `? I can introduce you to ${i.supplierName} directly` : ""}?

${sig}

[SIMULATED DRAFT — generated without a model. Add ANTHROPIC_API_KEY for real copy.]`,
    },
    followUps: [
      {
        delayDays: 4,
        subject: `Re: ${i.productName} for ${i.companyName}`,
        body: `Hi ${i.contactName.split(" ")[0]},\n\nAdding one thing: lead times tighten closer to the window, so ordering earlier protects the date.\n\nStill happy to send details.\n\n${i.senderName}\n\n[SIMULATED DRAFT]`,
      },
      {
        delayDays: 10,
        subject: `Closing the loop — ${i.productName}`,
        body: `Hi ${i.contactName.split(" ")[0]},\n\nI'll stop here unless it's useful. If timing is wrong, tell me when to come back and I will.\n\n${i.senderName}\n\n[SIMULATED DRAFT]`,
      },
    ],
    claimsMade: [],
    };
  },
};

export async function runOutreachWriter(businessId: string, matchId: string) {
  const match = await db.match.findUniqueOrThrow({
    where: { id: matchId },
    include: {
      product: { include: { supplier: true } },
      prospect: {
        include: {
          company: { include: { signals: true } },
          play: true,
          contacts: { include: { contact: true }, orderBy: { isPrimary: "desc" } },
        },
      },
      business: { include: { sendPolicy: true } },
    },
  });

  const primary = match.prospect.contacts[0]?.contact;
  if (!primary) throw new Error("No contact identified for this prospect yet.");

  // ADR-003: only sourced, unexpired facts may enter outbound copy.
  const verifiedFacts = match.prospect.company.signals
    .filter((s) => s.verification === "VERIFIED" && (!s.expiresAt || s.expiresAt > new Date()))
    .map((s) => `${s.title}${s.sourceUrl ? ` (${s.sourceUrl})` : ""}`);

  const p = match.product;
  // Services deliberately get no price in the cold email: nothing has been
  // scoped yet, so any number is either wrong or anchors against us.
  const price =
    p.kind === "SERVICE"
      ? undefined
      : p.priceMin && p.priceMax
        ? `${p.currency} ${Number(p.priceMin)}–${Number(p.priceMax)}${p.unit ? ` ${p.unit}` : ""}`
        : undefined;

  const agentInput = {
      senderName: match.business.sendPolicy?.senderName ?? match.business.name,
      senderBusiness: match.business.name,
      contactName: primary.fullName,
      contactRole: primary.jobTitle ?? "decision maker",
      companyName: match.prospect.company.name,
      companyContext: match.prospect.company.description ?? "No description recorded.",
      buyingTrigger: match.prospect.play?.buyingTrigger ?? "Seasonal purchasing period approaching",
      timingWindow: match.prospect.play?.timingWindow ?? undefined,
      productName: p.name,
      productDescription: p.description ?? undefined,
      priceRange: price,
      supplierName: p.supplier.name,
      isBrokered: !p.supplier.isSelf,
      isService: p.kind === "SERVICE",
      observedPain: match.observedPain ?? undefined,
      firstAsk: match.firstAsk ?? undefined,
      rationale: match.rationale,
    verifiedFacts,
  };

  // The same mechanical tone gate the other two writers use. The rules live in
  // the prompt, but a prompt is a request — this page shipped with a cold
  // opener, an invented revenue problem and a "worth a 15-minute call" close
  // long after those were banned everywhere else, because nothing checked.
  let res = await runAgent(agent, agentInput, { businessId });
  let violations = checkDraft(res.output.initial.subject, res.output.initial.body);

  if (violations.length) {
    const retry = await runAgent(
      agent,
      { ...agentInput, verifiedFacts: [...verifiedFacts, `REWRITE. The previous attempt broke these rules:
${violationBrief(violations)}`] },
      { businessId },
    );
    const rv = checkDraft(retry.output.initial.subject, retry.output.initial.body);
    if (rv.length < violations.length) { res = retry; violations = rv; }
  }

  const { output, runId, simulated } = res;

  // Post-hoc claim validation. A claim with no verified backing is a defect,
  // recorded on the draft rather than silently shipped.
  const unbacked = output.claimsMade.filter(
    (c) => !verifiedFacts.some((f) => f.toLowerCase().includes(c.toLowerCase().slice(0, 25))),
  );

  const message = await db.message.create({
    data: {
      businessId,
      matchId,
      contactId: primary.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      status: "PENDING_APPROVAL",
      subject: output.initial.subject,
      bodyText: output.initial.body,
      agentRunId: runId,
      classifierNotes: unbacked.length
        ? `UNVERIFIED CLAIMS — review before sending:\n${unbacked.join("\n")}`
        : null,
    },
  });

  if (match.status === "PROPOSED" || match.status === "APPROVED") {
    await db.match.update({ where: { id: matchId }, data: { status: "APPROVED" } });
  }
  await db.activity.create({
    data: {
      prospectId: match.prospectId,
      type: "draft_created",
      summary: `Outreach drafted for ${p.name}${unbacked.length ? ` — ${unbacked.length} unverified claim(s) flagged` : ""}`,
    },
  });

  return { messageId: message.id, unbacked, simulated, followUps: output.followUps };
}

export const outreachWriter = agent;
