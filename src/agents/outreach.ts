import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";
import { checkDraft, violationBrief } from "@/lib/outreach/quality";
import { displayCompanyName, isRoleInbox } from "@/lib/entity";
import { reportLinkFor } from "@/lib/leadmagnet/report";
import { verifiedFactsFor } from "@/lib/facts";
import { publicBaseUrl, publicUrlConfigured } from "@/lib/public-url";

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
  /**
   * True when the address is a shared mailbox rather than a person. Across 841
   * Singapore companies collected, this is true for every single one.
   */
  isRoleInbox: z.boolean(),
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
  /**
   * A link to a free one-page report on their own website.
   *
   * When present this REPLACES the ask. "Will you give me twenty minutes" is
   * the highest-friction thing you can put to a stranger; "here is a free
   * thing, no reply needed" is close to the lowest, and the report costs
   * nothing to produce because the audit already ran.
   */
  reportUrl: z.string().optional(),
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

STRUCTURE

0. GREET THEM. Always. "Hi <first name>," only when you were given a real person's name;
   "Hi there," whenever the address is a shared mailbox. An email that starts mid-thought
   reads as a mail-merge, because that is what mail-merges do — this is the single biggest
   thing separating a note from a blast.

   Never invent or guess a name, and never turn a company or a mailbox into one. Real
   contact records here read "prosupport", "feedback", "chanbro" and "Coolaircon (hello)",
   and greeting somebody "Hi Bond," or "Hi feedback," is worse than using no name at all:
   it proves nobody looked.
1. OPEN ON WHAT YOU WERE TRYING TO DO AND COULDN'T. First sentence, no preamble.

     "I was trying to find an enquiry form on your site and couldn't."
     "I was looking for a way to book on your site and ended up hunting for a number."

   That is the whole opening. Do not warm up to it, do not explain how you found them,
   and do not put a season or a reason in front of it. Say the thing.

2. WHO YOU ARE, in one line. You are a developer who builds this for trades firms. Not a
   consultant, not an agency, not "I help businesses with digital solutions" — a person who
   writes the software and would do the work himself.

3. THE FIX, and it is SCHEDULING AND REMINDERS, not "a booking system".

   The two things being sold, in the owner's language:

     Smart scheduling      assign jobs to technicians and group them by area, so a crew
                           is not crossing the island twice in a day
     Automated reminders   the customer gets a WhatsApp or SMS when their unit is due
                           again, with one tap to rebook — so the next job does not
                           depend on them remembering

   Name the one that fits what you found, concretely enough to picture. An owner can see
   "a message that goes out when the unit is due, with one tap to rebook". Nobody can see
   "a booking system" or "conversion optimisation".

4. CLOSE BY OFFERING A CALL, plainly and once.

     "If it's worth discussing, happy to jump on a call."
     "Happy to talk it through if it's useful."

NEVER SOUND GRATEFUL FOR THEIR ATTENTION

Banned outright, because they read as apologising for existing:
  "no reply needed", "no need to reply", "leave this where it is", "no harm done",
  "if it's not the right time, no problem", "sorry to bother you", "I'll leave you to it".

You are a developer who found a real problem on their site and can fix it. That is a useful
email to receive. Write like somebody who knows that.

NO SEASONAL URGENCY

Banned: "before the busy season", "ahead of the hot months", "before the year-end rush",
"now is a good time to". It is invented urgency, it is transparent, and it delays the
sentence they actually need to read.

WHEN reportUrl IS PRESENT, THE LINK IS THE ASK

Give them the report and ask for nothing. Do not request a call, a reply, or their time —
the whole reason this works is that it costs them nothing, and appending "and if you like
it, shall we talk?" converts a gift back into a pitch.

Say what it is in one plain line, give the link, and say they do not need to reply. One
observation from it is enough to make the link worth clicking; listing all of them means
there is no reason to open it.

HARD RULES

- THE FIRST SENTENCE MUST NOT ASK FOR ANYTHING. Never open with "Could you point me to",
  "Can you", "Are you the person", "I'm reaching out", "I wanted to introduce", "Quick
  question", or "I hope this finds you well".

- DO NOT NARRATE YOUR OWN BROWSING. Never "I was looking through aircon companies this
  week", "I ended up on your site for a while", "I spent a few minutes on your website".
  It is meant to sound personal and it lands as surveillance: the reader pictures a
  stranger sitting and studying their business. If how you found them genuinely matters,
  one clause does it — "came across your site while looking at aircon firms here". Usually
  it does not matter, and saying what you want is friendlier than explaining how you got
  there.

- ONE CAVEAT, AT MOST — AND NEVER BRACKET THE OBSERVATION WITH TWO.

  This is the commonest failure there is: 15 drafts out of 57 in a single run qualified on
  the way in AND on the way out.

    "Going by your site AS A VISITOR, there's no enquiry form. That's just what's
     visible FROM OUTSIDE."

    "LOOKING AT YOUR SITE THE WAY A CUSTOMER WOULD, I couldn't find a form — that's only
     what I saw FROM THE OUTSIDE, NOT A COMMENT ON how you actually take work in."

  Each half sounds careful on its own. Together they say the same thing twice and turn one
  plain observation into an apology for having looked. Pick one end, drop the other:
  "I couldn't find an enquiry form on the site, though I'm only seeing it from outside"
  does the whole job in one clause.

  Each of these counts as your one caveat — "as a visitor", "from outside", "a visitor's
  view", "all I can see is", "not a comment on", "I don't know how", "I could be wrong".
  Use at most one of them in the entire email.

- VARY THE WORDING, not the structure. The opening and the close are fixed in shape by the
  four steps above; what must not repeat word for word across companies is the phrasing.
  Five drafts written on the same day once ended with the identical two sentences, which is
  what a template looks like to two owners who compare notes.

  (This replaced a rule saying "do not open on what they lack". That rule was written to
  keep the email out of the predatory-audit register and it overshot: it produced drafts
  that buried their own point behind a season and an apology. Leading with the problem is
  right — what keeps it civil is telling it as YOUR experience as a visitor, which is what
  step 1 does.)

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
  thin, say plainly what you do and why you thought it might be relevant, and make NO
  claims about them. A short honest email with nothing specific in it is better than a
  longer one padded with how you found them. Never invent social proof — no "your name came
  up", no "I've heard good things". List every claim in claimsMade.

- When isBrokered is true you are making an INTRODUCTION, not selling your own product.
  Say plainly that you work with the supplier. Do not imply the product is yours.

THE OBSERVATION IS ABOUT THEIR CUSTOMER, NOT ABOUT THEIR WEBSITE

This is the single thing that decides whether this email gets answered or resented, and
it is a change of narrator, not of tone. The same true fact reads completely differently
depending on whose side it is told from:

  "There are twelve different prices on your page."
      An accusation. It says: you are confusing. They will defend the page, or delete
      the email, and either way they will not reply.

  "I couldn't work out which price applied to me."
      An observation from a customer's seat. It is impossible to argue with, because
      you are only reporting what happened to you — and it is the version that gets a
      reply, because the owner immediately wants to know how often it happens.

Always take the second form. You are not auditing their website; you are telling them
what happened when somebody tried to buy from them. Say "I", say what you could not find
or could not work out, and never characterise the page.

NEVER: "your site has no clear call to action", "your booking form is badly placed",
"your pricing is inconsistent", "your homepage is too long", "you're losing customers".
That last one is the worst — it claims to know their business, and it is the sentence
every predatory web agency in Singapore opens with.

WHAT THE ASK SHOULD BE

You want a reply, and the reliable way to get one is a question the owner already has an
opinion about and can answer in a single line, without commitment. What they know and you
do not: how work actually reaches them.

  Good:  "Roughly what share of your bookings come through the site rather than the phone?"
  Good:  "Is the website meant to take bookings, or is it mostly there so people can find
          your number?"
  Bad:   "Can we set up a call?"          (asks for time before giving anything)
  Bad:   "Are you interested?"            (asks them to evaluate you)
  Bad:   "Does this sound useful?"        (same, wearing a politer hat)

A question about their own operation costs nothing to answer, and the answer tells you
whether there is a sale here at all. If they say the site is only there for the phone
number, there is no problem to solve and you have learned that for the price of an email.

WHEN isService IS TRUE

You are offering a conversation, not a build. Mention what you noticed from outside, mark
it once as an outside observation, and leave it there — that single qualification is what
makes it credible, and repeating it is what makes it tiresome. Do not claim to know their
systems, their stack, or their internal processes. Do not quote the build.

CLOSING

Offer the call, once, and stop. "If it's worth discussing, happy to jump on a call."

Do not soften it afterwards. The sentence after the offer is where the apologising used to
creep in — "and if not, no reply needed", "no harm done", "I'll leave you to it" — and it
undoes the offer it follows. End on the offer.

Do not propose a specific time or ask them to book a slot. Offering a call and scheduling
one are different things, and the second is presumptuous in a first email.

SUBJECT LINES

Curious and personal, never a campaign. Under 55 characters. Never a price, a percentage,
a month, or a market claim.

FOLLOW-UPS

Two maximum, each adding something new. Never "just bumping this up".

VOICE AND LENGTH

Write the way you would to somebody whose work you respect and whose time is short.
Contractions, plain sentences, no throat-clearing. Warm is not the same as chatty: the
warmth comes from being direct and easy to say no to, not from adjectives. 90 to 150
words — the friendlier version is usually the shorter one.`;

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "OUTREACH",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) => `From: ${i.senderName} at ${i.senderBusiness}
To: ${i.isRoleInbox ? `a shared mailbox at ${i.companyName} — GREET "Hi there," and use NO personal name` : `${i.contactName}, ${i.contactRole} at ${i.companyName}`}

Company context: ${i.companyContext}
Why now: ${i.buyingTrigger}${i.timingWindow ? `\nTiming: ${i.timingWindow}` : ""}

Pitching: ${i.productName}${i.priceRange ? ` (${i.priceRange})` : ""}
${i.productDescription ?? ""}
Supplier: ${i.supplierName}${i.isBrokered ? " — PARTNER, this is an introduction" : " — our own product"}
Type: ${i.isService ? "SERVICE — ask for a diagnostic call, do not quote a build" : "PRODUCT"}
${i.observedPain ? `Symptom observed: ${i.observedPain}` : ""}
${i.reportUrl ? `FREE REPORT LINK — this is the ask, give it and request nothing: ${i.reportUrl}` : i.firstAsk ? `Suggested ask: ${i.firstAsk}` : ""}
Why this for them: ${i.rationale}

Verified facts you may reference (${i.verifiedFacts.length}):
${i.verifiedFacts.length ? i.verifiedFacts.map((f) => `- ${f}`).join("\n") : "(none — make no factual claims about this company)"}`,
  mock: (i) => {
    const trim = (s: string) => s.replace(/\s*[.;]+\s*$/, "");
    const first = i.isRoleInbox ? "there" : i.contactName.split(" ")[0];
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
        body: `Hi ${i.isRoleInbox ? "there" : i.contactName.split(" ")[0]},\n\nAdding one thing: lead times tighten closer to the window, so ordering earlier protects the date.\n\nStill happy to send details.\n\n${i.senderName}\n\n[SIMULATED DRAFT]`,
      },
      {
        delayDays: 10,
        subject: `Closing the loop — ${i.productName}`,
        body: `Hi ${i.isRoleInbox ? "there" : i.contactName.split(" ")[0]},\n\nI'll stop here unless it's useful. If timing is wrong, tell me when to come back and I will.\n\n${i.senderName}\n\n[SIMULATED DRAFT]`,
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
          company: { include: { signals: true, siteAudit: { select: { id: true, reliable: true } } } },
          play: true,
          contacts: { include: { contact: true }, orderBy: { isPrimary: "desc" } },
        },
      },
      business: { include: { sendPolicy: true } },
    },
  });

  const primary = match.prospect.contacts[0]?.contact;
  if (!primary) throw new Error("No contact identified for this prospect yet.");

  // ADR-003: only sourced facts may enter outbound copy.
  //
  // This used to read company.signals, and BuyingSignal has never had a row
  // written to it — nothing produces buying signals, because funding rounds and
  // hiring sprees are enterprise phenomena that a twelve-person aircon firm does
  // not announce. So verifiedFacts was empty for every email ever drafted, and
  // the prompt rule "every factual claim must come from verifiedFacts" meant the
  // model correctly refused to say anything specific about anybody.
  //
  // Worse, the company's own description was arriving in the same prompt as
  // "Company context" while the rules forbade using it. The model was reading
  // "T32 Dental Group manages 8 dental clinics across Singapore" and a rule
  // saying it may only reference an empty list.
  const verifiedFacts = [
    ...(await verifiedFactsFor(match.prospect.companyId)),
    // Kept for when something does produce them.
    ...match.prospect.company.signals
      .filter((s) => s.verification === "VERIFIED" && (!s.expiresAt || s.expiresAt > new Date()))
      .map((s) => `${s.title}${s.sourceUrl ? ` (${s.sourceUrl})` : ""}`),
  ];

  const p = match.product;
  // Services deliberately get no price in the cold email: nothing has been
  // scoped yet, so any number is either wrong or anchors against us.
  const price =
    p.kind === "SERVICE"
      ? undefined
      : p.priceMin && p.priceMax
        ? `${p.currency} ${Number(p.priceMin)}–${Number(p.priceMax)}${p.unit ? ` ${p.unit}` : ""}`
        : undefined;

  // The lead magnet, where the company has an audit worth showing. Created
  // before drafting so the writer can put the actual URL in the body rather
  // than a placeholder that would have to be substituted afterwards.
  // Skipped rather than failed when no public URL is configured: the email is
  // still worth sending with its normal ask, and a hard failure here would
  // block every draft on a setting that only matters once a domain exists.
  // reliable only: on a client-rendered site nothing can be asserted missing,
  // so the report has nothing to tell them and offering one spends a send to
  // deliver a shrug.
  const reportUrl =
    match.prospect.company.siteAudit?.reliable && publicUrlConfigured()
      ? `${publicBaseUrl()}/r/${await reportLinkFor(businessId, match.prospect.companyId)}`
      : undefined;

  const agentInput = {
      senderName: match.business.sendPolicy?.senderName ?? match.business.name,
      senderBusiness: match.business.name,
      contactName: primary.fullName,
      contactRole: primary.jobTitle ?? "decision maker",
      isRoleInbox: isRoleInbox(primary.fullName, primary.jobTitle, match.prospect.company.name),
      // Not the raw row. One draft opened by telling the recipient it had
      // "ended up on your Our Services & Capabilities page" — the company's
      // stored name was a scraped nav heading, and the writer used it as
      // faithfully as it would have used a real one.
      companyName:
        displayCompanyName(
          match.prospect.company.name,
          match.prospect.company.primaryDomain,
          match.prospect.company.industry ?? undefined,
        ) ?? match.prospect.company.name,
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
      reportUrl,
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

  // Store the follow-ups.
  //
  // These were being written and thrown away — the writer produced two per
  // email, returned them, and nothing here saved them. In cold outreach most
  // replies come from the second and third touch, so that was the majority of
  // the value generated, discarded on every run.
  //
  // Saved as DRAFT with no scheduledAt rather than SCHEDULED with a date: a
  // follow-up to an email that never sent is not due in four days, it is not
  // due at all. The send path sets the real dates once the parent goes out.
  for (const f of output.followUps) {
    await db.message.create({
      data: {
        businessId,
        matchId,
        contactId: primary.id,
        parentMessageId: message.id,
        channel: "EMAIL",
        direction: "OUTBOUND",
        status: "DRAFT",
        subject: f.subject,
        bodyText: f.body,
        agentRunId: runId,
        gateDecision: { side: "FOLLOW_UP", delayDays: f.delayDays } as object,
      },
    });
  }

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
