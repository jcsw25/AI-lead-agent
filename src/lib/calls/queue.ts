import { db } from "@/lib/db";

/**
 * The phone lane.
 *
 * The database holds 1,334 phone numbers and 632 companies with one, and until
 * now every single outreach touch has been email. That is one of the Core Four
 * channels doing all the work while a second sits unused — and in Singapore SME
 * trades, where the owner answers their own mobile, the phone converts better
 * than the inbox.
 *
 * It also resolves the volume problem. A hundred outreach actions a day is not
 * achievable on email alone: a new sending domain cannot take it, and a hundred
 * messages on the same subject matter in 24 hours crosses the Spam Control Act
 * bulk threshold. Thirty emails, thirty calls and forty messages is the same
 * hundred actions with none of that risk.
 *
 * A call is stored as a Message with channel PHONE, not a separate model. It is
 * a touch on a contact with a direction and an outcome, which is what a Message
 * already is — and keeping them in one table means the daily action count, the
 * per-company history and the "already contacted" guard all work across
 * channels without being written twice.
 */

export type CallTarget = {
  companyId: string;
  contactId: string;
  company: string;
  industry: string | null;
  phone: string;
  websiteUrl: string | null;
  /** The one checkable thing to open with. */
  observation: string | null;
  /** Whether an email has already gone to this company, and what happened. */
  emailStatus: "none" | "sent" | "replied";
  /** Times they opened the free report. The best signal available pre-conversation. */
  reportViews: number;
  /** Worked to the front by hand from the Leaks list. */
  pinned: boolean;
  grade: string | null;
};

/**
 * Who to call next.
 *
 * Ranked by how warm they are rather than by score. Somebody who was emailed
 * three days ago and has not replied is a far better call than a stranger — the
 * email is the introduction the call gets to refer to, and "I sent you a note
 * on Tuesday" is a legitimate opener where a cold dial is not.
 */
export async function callQueue(
  businessId: string,
  opts: { industry?: string; limit?: number } = {},
): Promise<CallTarget[]> {
  const limit = opts.limit ?? 40;

  const contacts = await db.contact.findMany({
    where: {
      phone: { not: null },
      ...(opts.industry
        ? { company: { industry: { contains: opts.industry, mode: "insensitive" } } }
        : {}),
      // Never call somebody who asked not to be contacted. The suppression list
      // is scoped to email addresses, so the company's prospect stage is the
      // check that works for a phone number.
      company: {
        ...(opts.industry ? { industry: { contains: opts.industry, mode: "insensitive" } } : {}),
        prospects: { none: { businessId, stage: "SUPPRESSED" } },
      },
    },
    select: {
      id: true,
      phone: true,
      companyId: true,
      company: {
        select: {
          id: true, name: true, industry: true, websiteUrl: true,
          siteAudit: { select: { findings: true, reliable: true, leakFindings: true, leakScore: true } },
          pinnedForCallAt: true,
          qualifications: { where: { businessId }, select: { grade: true }, take: 1 },
        },
      },
    },
    // Pinned first at the QUERY level, not just in the sort below.
    //
    // Sorting afterwards is not enough: this fetches a window of contacts, and
    // a company pinned from the Leaks page is usually far outside it — so the
    // pin appeared to do nothing. Ordering here guarantees a pinned company is
    // inside the window it then gets sorted within.
    orderBy: { company: { pinnedForCallAt: { sort: "desc", nulls: "last" } } },
    take: limit * 6,
  });

  // One row per company: calling the same firm on two numbers is the fastest
  // way to be remembered badly.
  const byCompany = new Map<string, (typeof contacts)[number]>();
  for (const c of contacts) if (!byCompany.has(c.companyId)) byCompany.set(c.companyId, c);

  const companyIds = [...byCompany.keys()];

  const [emails, calls, reports] = await Promise.all([
    db.message.findMany({
      where: {
        businessId, direction: "OUTBOUND", channel: "EMAIL", status: "SENT",
        contact: { companyId: { in: companyIds } },
      },
      select: { repliedAt: true, contact: { select: { companyId: true } } },
    }),
    // Already called? Then not in this queue.
    db.message.findMany({
      where: { businessId, channel: "PHONE", contact: { companyId: { in: companyIds } } },
      select: { contact: { select: { companyId: true } } },
    }),
    // Who opened the report we sent them.
    db.siteReport.findMany({
      where: { businessId, companyId: { in: companyIds }, viewCount: { gt: 0 } },
      select: { companyId: true, viewCount: true },
    }),
  ]);
  const views = new Map(reports.map((r) => [r.companyId, r.viewCount]));

  const emailed = new Map<string, "sent" | "replied">();
  for (const e of emails) {
    const id = e.contact?.companyId;
    if (!id) continue;
    if (e.repliedAt) emailed.set(id, "replied");
    else if (!emailed.has(id)) emailed.set(id, "sent");
  }
  const called = new Set(calls.map((c) => c.contact?.companyId).filter(Boolean) as string[]);

  const out: CallTarget[] = [];
  for (const c of byCompany.values()) {
    if (called.has(c.companyId)) continue;
    const findings = (c.company.siteAudit?.findings as string[] | null) ?? [];
    const leaks = (c.company.siteAudit?.leakFindings as string[] | null) ?? [];
    out.push({
      companyId: c.companyId,
      contactId: c.id,
      company: c.company.name,
      industry: c.company.industry,
      phone: c.phone!,
      websiteUrl: c.company.websiteUrl,
      // Only where the audit could actually see the page. An opener that turns
      // out to be wrong is worse on a call than in an email — they will say so,
      // out loud, immediately.
      // The leak finding is the better opener on a call for the same reason it
      // is in an email: "your booking form is most of the way down the page" is
      // something the person can check while you are talking to them.
      observation: c.company.siteAudit?.reliable ? (leaks[0] ?? findings[0] ?? null) : null,
      emailStatus: emailed.get(c.companyId) ?? "none",
      reportViews: views.get(c.companyId) ?? 0,
      pinned: Boolean(c.company.pinnedForCallAt),
      grade: c.company.qualifications[0]?.grade ?? null,
    });
  }

  // An opened report outranks everything except an actual reply.
  //
  // It is the only signal available before anyone speaks: they received a cold
  // email, decided it was worth a click, and read a page about their own
  // business. A second open usually means it was forwarded to somebody else,
  // which is stronger still — so views count, not just the fact of one.
  const warmth = { replied: 0, sent: 2, none: 3 } as const;
  const rank = (t: CallTarget) =>
    t.emailStatus === "replied" ? 0 : t.reportViews > 0 ? 1 : warmth[t.emailStatus];

  // A pin is a human decision and outranks every computed signal here.
  out.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      rank(a) - rank(b) ||
      b.reportViews - a.reportViews ||
      (a.grade ?? "Z").localeCompare(b.grade ?? "Z"),
  );
  return out.slice(0, limit);
}

/** What a call can end as. Kept short — a long list never gets used honestly. */
export const CALL_OUTCOMES = [
  "No answer",
  "Wrong number",
  "Gatekeeper — call back",
  "Spoke to owner — interested",
  "Spoke to owner — not now",
  "Spoke to owner — no",
  "Asked not to be contacted",
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/**
 * Record a call.
 *
 * Stored as a SENT outbound Message so it counts as a touch everywhere touches
 * are counted, and so the next email to this company knows a call already
 * happened.
 */
export async function logCall(
  businessId: string,
  contactId: string,
  outcome: CallOutcome,
  notes: string,
) {
  const message = await db.message.create({
    data: {
      businessId,
      contactId,
      channel: "PHONE",
      direction: "OUTBOUND",
      status: "SENT",
      sentAt: new Date(),
      outcome,
      bodyText: notes || null,
    },
  });

  // A refusal on the phone is as binding as one in writing, and acting on it
  // has to be immediate rather than a note somebody reads later.
  if (outcome === "Asked not to be contacted") {
    const contact = await db.contact.findUnique({
      where: { id: contactId },
      select: { companyId: true },
    });
    if (contact) {
      await db.prospect.updateMany({
        where: { businessId, companyId: contact.companyId },
        data: { stage: "SUPPRESSED", disqualifiedReason: "Asked not to be contacted, by phone" },
      });
    }
  }

  return message;
}

/**
 * Touches made today, by channel.
 *
 * One number, checked daily. The point is not the total but the shape: a day
 * with 30 emails and no calls is a day spent on one channel, which is the habit
 * this whole lane exists to break.
 */
export async function touchesToday(businessId: string) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const rows = await db.message.groupBy({
    by: ["channel"],
    where: {
      businessId,
      direction: "OUTBOUND",
      status: { in: ["SENT", "DELIVERED"] },
      sentAt: { gte: since },
    },
    _count: { _all: true },
  });

  const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r._count._all])) as Record<string, number>;
  const total = Object.values(byChannel).reduce((a, b) => a + b, 0);
  return { byChannel, total };
}
