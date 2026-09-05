/**
 * Does the tone gate catch what made the drafts feel like a mail-merge?
 *
 *   npx tsx scripts/test-tone.ts
 *
 * Free — no model calls. Every BAD case below is lifted from a draft that was
 * actually sitting in the approval queue. They read as unfriendly for reasons
 * that are individually small and cumulatively fatal: no greeting at all, an
 * opening that narrates the sender watching the recipient, two or three
 * apologies for having written, and a sign-off five other drafts also used.
 *
 * The GOOD case matters as much as the bad ones. A checker that rejects
 * everything is not strict, it is broken, and it fails invisibly by making
 * every draft look equally bad.
 */
import { checkDraft } from "@/lib/outreach/quality";

type Case = { name: string; subject: string; body: string; expect: string | null };

const SUBJECT = "Something about your booking page";

const CASES: Case[] = [
  {
    name: "the shape we now want — must pass clean",
    subject: "Couldn't find a way to book on your site",
    body: `Hi there,

I was trying to find an enquiry form on your site and couldn't — ended up hunting for a number instead.

I'm a developer, I build scheduling software for aircon firms here in Singapore.

The bit that would help you is automated reminders: when a unit is due for its next service the customer gets a WhatsApp or SMS, with one tap to rebook. It sits on top of whatever records you already keep.

If it's worth discussing, happy to jump on a call.

Jason`,
    expect: null,
  },
  {
    name: "no greeting — the mail-merge tell",
    subject: SUBJECT,
    body: `I build a phone assistant for trades firms here in Singapore, and yours seemed worth a short note before the hot stretch picks up. It answers when nobody can, takes the address and the unit count, and texts back a confirmation. If it's the wrong moment, no need to reply.

Jason`,
    expect: "no greeting",
  },
  {
    name: "narrates its own browsing",
    subject: SUBJECT,
    body: `Hi there,

I was looking through aircon service companies in Singapore this week and ended up on your site for a while. There's no enquiry form on it, so someone ready to book has to find another way to reach you.

I build an assistant that answers when nobody can, takes the address and the unit count, and texts back a confirmation. If it's the wrong moment, no need to reply at all.

Jason`,
    expect: "narrates your browsing",
  },
  {
    name: "apologises three times for having written",
    subject: SUBJECT,
    body: `Hi there,

I build phone answering for trades firms. From the outside there's no enquiry form on your site, so someone ready to book has to call.

That's just what I saw as a visitor, and I don't know anything about how you actually take bookings. I'm guessing at all of it, so I could be completely wrong.

The assistant answers when nobody can, takes the address and the unit count, and texts a confirmation. If it's the wrong moment, leave it there.

Jason`,
    expect: "over-hedged",
  },
  {
    name: "closes with the sign-off every other draft used",
    subject: SUBJECT,
    body: `Hi there,

I build phone answering for trades firms, and yours looked like the kind of place it might suit.

The assistant answers when nobody can, takes the address, the unit count and the slot they'd prefer, and texts back a confirmation.

If it's something you'd be open to exploring, happy to tell you a bit more.

Jason`,
    expect: "stock close",
  },
  {
    name: "judges their website instead of reporting a visitor's experience",
    subject: "Something about your booking page",
    body: `Hi there,

I build phone answering for trades firms in Singapore.

Your site has no clear call to action, and there are 12 different prices on your page, which is costing you leads.

The assistant answers when nobody can, takes the address and the unit count, and texts back a confirmation. If now's the wrong time, leave it there.

Jason`,
    expect: "verdict on their site",
  },
  {
    name: "the same finding told from the visitor's seat — must pass",
    subject: "The pricing on your site",
    body: `Hi there,

I was trying to work out what a three-room service would cost on your site and couldn't — there are several different prices and I couldn't tell which applied to me.

I'm a developer, I build scheduling and reminder software for aircon firms here.

Smart scheduling is the piece that usually helps: jobs get assigned to whoever is nearest and grouped by area, so a crew isn't crossing the island twice in a day.

Happy to talk it through if it's useful.

Jason`,
    expect: null,
  },
  {
    name: "apologises its way out of the close",
    subject: SUBJECT,
    body: `Hi there,

I was trying to find an enquiry form on your site and couldn't.

I'm a developer, I build scheduling software for aircon firms. Automated reminders would message the customer when their unit is due, with one tap to rebook.

If it's worth discussing, happy to jump on a call. And if this isn't useful, please just leave it — no reply needed.

Jason`,
    expect: "apologetic close",
  },
  {
    name: "manufactures a season to justify writing",
    subject: SUBJECT,
    body: `Hi there,

I wanted to put one small idea in front of you before the busy purchasing season gets going, since it's the sort of thing that's easier to set up now.

I'm a developer, I build scheduling software for aircon firms. Automated reminders message the customer when their unit is due, with one tap to rebook.

If it's worth discussing, happy to jump on a call.

Jason`,
    expect: "invented urgency",
  },
  {
    name: "reaches for the stock way of introducing the observation",
    subject: SUBJECT,
    body: `Hi there,

I build phone answering software for trades firms in Singapore.

One thing I noticed from the outside: there's no enquiry form on your site, so someone ready to book has to find another way in.

The assistant answers when nobody can, takes the address and the unit count, and texts back a confirmation. If now's the wrong time, leave this where it is — no reply needed.

Jason`,
    expect: "stock observation",
  },
];

let pass = 0;
let fail = 0;

for (const c of CASES) {
  const v = checkDraft(c.subject, c.body);
  const rules = v.map((x) => x.rule);
  const ok = c.expect === null ? v.length === 0 : rules.includes(c.expect);
  if (ok) {
    pass++;
    console.log(`ok    ${c.name}`);
  } else {
    fail++;
    console.log(`FAIL  ${c.name}`);
    console.log(`      expected ${c.expect ?? "a clean pass"}, got ${rules.length ? rules.join(", ") : "nothing"}`);
    for (const x of v) console.log(`        ${x.rule}: ${x.detail.slice(0, 110)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
