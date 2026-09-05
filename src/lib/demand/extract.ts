import { db } from "@/lib/db";
import { runAgent } from "@/agents/runtime";
import { needExtractor, quoteIsReal } from "@/agents/need-extractor";
import { suppressContact } from "@/lib/outreach/suppress";
import { canonicalCategory } from "@/lib/demand/category";

/**
 * Turning a reply into evidence.
 *
 * This is the step the demand-first model was missing. Probes go out and
 * replies come back, but nothing read them — so a Need could reach PROBED and
 * stop there, which is why 746 suspected needs had no path to becoming facts. A
 * supplier can only be told about a need somebody actually stated, so without
 * this the model had no product to sell.
 *
 * The rule the rest of the system leans on:
 *
 *     CONFIRMED requires a verbatim quote that we verified appears in a real
 *     inbound message, and a sourceMessageId pointing at that message.
 *
 * It is checked here in code, after the model has answered. If the quote is not
 * in the reply the whole extraction is discarded and the need stays PROBED —
 * because the failure mode is not a wasted email, it is telling a supplier that
 * a company said something it never said.
 */

export type ExtractResult = {
  needId: string | null;
  companyName: string;
  status: "CONFIRMED" | "DEAD" | "PROBED" | "SKIPPED";
  why: string;
  verbatim?: string;
  incumbent?: string | null;
  otherNeedCreated?: string;
  costUsd: number;
};

/** Model urgency maps straight onto the schema enum; the two were defined together. */
const URGENCY_CONFIDENCE: Record<string, number> = {
  NOW: 0.95,
  THIS_QUARTER: 0.85,
  SOMEDAY: 0.7,
  NOT_IN_MARKET: 0.4,
};

/**
 * Which need does this reply answer?
 *
 * The probe message is the link: Gmail's threadId ties the inbound message to
 * the outbound one, and that outbound id sits on the Need as probeMessageId.
 * Where the thread is missing we fall back to the company's most recently
 * probed need — a guess, but a narrow one, and the basis is recorded on the
 * need so it can be audited rather than assumed.
 */
async function needForReply(businessId: string, inboundId: string) {
  const inbound = await db.message.findFirstOrThrow({
    where: { id: inboundId, businessId, direction: "INBOUND" },
    include: { contact: { select: { id: true, email: true, companyId: true, company: { select: { name: true } } } } },
  });

  if (!inbound.contact) return { inbound, need: null, matchedBy: "no contact on the message" };

  if (inbound.providerThreadId) {
    const outbound = await db.message.findFirst({
      where: { businessId, direction: "OUTBOUND", providerThreadId: inbound.providerThreadId },
      orderBy: { sentAt: "desc" },
      select: { id: true },
    });
    if (outbound) {
      const need = await db.need.findFirst({ where: { businessId, probeMessageId: outbound.id } });
      if (need) return { inbound, need, matchedBy: "email thread" };
    }
  }

  const need = await db.need.findFirst({
    where: { businessId, companyId: inbound.contact.companyId, status: { in: ["PROBED", "SUSPECTED"] } },
    orderBy: [{ probedAt: "desc" }, { confidence: "desc" }],
  });
  return {
    inbound,
    need,
    matchedBy: need ? "most recent open need for the company" : "company has no open need",
  };
}

/** The question we put to them, so the model knows what it is reading an answer to. */
function questionFrom(gateDecision: unknown): string {
  const g = gateDecision as { question?: string } | null;
  return g?.question ?? "whether they currently need this, and who they use today";
}

export async function extractFromReply(businessId: string, inboundMessageId: string): Promise<ExtractResult> {
  const { inbound, need, matchedBy } = await needForReply(businessId, inboundMessageId);
  const companyName = inbound.contact?.company.name ?? "unknown company";
  const base = { needId: need?.id ?? null, companyName, costUsd: 0 };

  if (!inbound.bodyText?.trim()) return { ...base, status: "SKIPPED", why: "the reply has no text" };
  // An out-of-office is not an answer, and reading one costs a model call for
  // nothing. The pattern classifier has already caught these.
  if (inbound.replyClass === "AUTO_REPLY") return { ...base, status: "SKIPPED", why: "auto-reply, not an answer" };
  if (!need) return { ...base, status: "SKIPPED", why: matchedBy };
  if (need.status === "CONFIRMED" || need.status === "FILLED") {
    return { ...base, status: "SKIPPED", why: `already ${need.status.toLowerCase()}` };
  }

  const probe = need.probeMessageId
    ? await db.message.findUnique({ where: { id: need.probeMessageId }, select: { gateDecision: true } })
    : null;

  const run = await runAgent(
    needExtractor,
    {
      ourQuestion: questionFrom(probe?.gateDecision),
      category: need.category,
      companyName,
      replyText: inbound.bodyText,
    },
    { businessId },
  );
  const x = run.output;
  const costUsd = run.costUsd;

  // Someone asking to be left alone is acted on before anything else is
  // recorded, exactly as in the reply poller. The pattern list there catches
  // the blunt phrasings; this catches the ones written politely.
  if (x.wantsNoContact) {
    if (inbound.contact?.email) {
      await suppressContact(businessId, inbound.contact.email, "Asked not to be contacted, in a reply.");
    }
    await db.need.update({
      where: { id: need.id },
      data: {
        status: "DEAD",
        urgency: "NOT_IN_MARKET",
        sourceMessageId: inbound.id,
        notes: `${need.notes ?? ""}\nAsked not to be contacted again (${new Date().toISOString().slice(0, 10)}).`.trim(),
      },
    });
    return { ...base, costUsd, status: "DEAD", why: "asked not to be contacted" };
  }

  // THE GATE. A quote that is not in the reply means the extraction cannot be
  // trusted at all — not merely that one field — so nothing is written and the
  // need stays where it was for a human to read.
  if (!quoteIsReal(x.verbatim, inbound.bodyText)) {
    await db.need.update({
      where: { id: need.id },
      data: { notes: `${need.notes ?? ""}\nExtraction rejected: the quoted words are not in the reply.`.trim() },
    });
    return { ...base, costUsd, status: "PROBED", why: "quoted words did not appear in the reply — extraction discarded" };
  }

  if (!x.answeredTheQuestion) {
    return { ...base, costUsd, status: "PROBED", why: `did not answer: ${x.reasoning.slice(0, 120)}` };
  }

  // Something they raised that we did not ask about — often the more valuable
  // half of the reply. Recorded as SUSPECTED rather than CONFIRMED: they
  // mentioned it, but the quote we verified is about the category we asked
  // about, and only a verified quote may confirm a need.
  let otherNeedCreated: string | undefined;
  if (x.otherNeed && inbound.contact) {
    // Filed under the name the rest of the system uses where we have one, so a
    // buyer asking for "a good commercial cleaner" does not create a category
    // no pairing and no supplier search will ever match. Their own words
    // survive in the quote either way.
    const { category, mergedInto, ambiguousWith } = await canonicalCategory(businessId, x.otherNeed);
    const raised =
      `They raised this themselves in a reply about ${need.category}. They said "${x.otherNeed}". ` +
      `Worth one direct question.` +
      (mergedInto ? ` Filed under our existing category.` : "") +
      (ambiguousWith ? ` Left in their words — it could be ${ambiguousWith.join(" or ")}.` : "");

    const dupe = await db.need.findUnique({
      where: { businessId_companyId_category: { businessId, companyId: inbound.contact.companyId, category } },
      select: { id: true, status: true, confidence: true, notes: true },
    });

    if (!dupe) {
      await db.need.create({
        data: {
          businessId,
          companyId: inbound.contact.companyId,
          category,
          status: "SUSPECTED",
          urgency: "SOMEDAY",
          confidence: 0.55,
          sourceMessageId: inbound.id,
          notes: raised,
        },
      });
      otherNeedCreated = category;
    } else if (dupe.status === "SUSPECTED") {
      // The strongest signal in the whole reply, and skipping the row as a
      // duplicate would have thrown it away. We guessed this company might need
      // this; unprompted, they said so themselves. That is not the same
      // inference any more, and the probe queue is ordered by confidence — so
      // without this the need they actually stated stays buried behind hundreds
      // nobody has mentioned.
      await db.need.update({
        where: { id: dupe.id },
        data: {
          confidence: Math.max(dupe.confidence, 0.65),
          sourceMessageId: inbound.id,
          notes: `${dupe.notes ?? ""}\n${raised}`.trim(),
        },
      });
      otherNeedCreated = `${category} (already suspected — they raised it unprompted)`;
    }
  }

  if (!x.hasNeedInThisCategory || x.urgency === "NOT_IN_MARKET") {
    await db.need.update({
      where: { id: need.id },
      data: {
        status: "DEAD",
        urgency: x.urgency,
        verbatim: x.verbatim,
        incumbent: x.incumbent,
        sourceMessageId: inbound.id,
        confidence: 0.9,
        // A no is a real answer and worth keeping. It says the category is live
        // for them, who holds it, and roughly when asking again would be fair.
        notes: `${need.notes ?? ""}\nAnswered no: ${x.reasoning.slice(0, 200)}`.trim(),
      },
    });
    return {
      ...base, costUsd, status: "DEAD", why: x.reasoning.slice(0, 140),
      verbatim: x.verbatim ?? undefined, incumbent: x.incumbent, otherNeedCreated,
    };
  }

  await db.need.update({
    where: { id: need.id },
    data: {
      status: "CONFIRMED",
      urgency: x.urgency,
      verbatim: x.verbatim,
      incumbent: x.incumbent,
      budgetHint: x.budgetHint,
      sourceMessageId: inbound.id,
      confirmedAt: new Date(),
      confidence: URGENCY_CONFIDENCE[x.urgency] ?? 0.8,
      notes: `${need.notes ?? ""}\nConfirmed from their reply (matched by ${matchedBy}). ${x.reasoning.slice(0, 200)}`.trim(),
    },
  });

  return {
    ...base, costUsd, status: "CONFIRMED", why: x.reasoning.slice(0, 140),
    verbatim: x.verbatim ?? undefined, incumbent: x.incumbent, otherNeedCreated,
  };
}

/**
 * Read every inbound reply that has not been extracted yet.
 *
 * "Not extracted yet" is derived — no need carries a sourceMessageId pointing
 * at the message — rather than flagged on the message. A separate processed
 * flag would drift out of step with the needs themselves the first time one was
 * reset by hand.
 */
export async function extractPending(businessId: string, opts: { limit?: number } = {}) {
  const inbound = await db.message.findMany({
    where: {
      businessId,
      direction: "INBOUND",
      replyClass: { notIn: ["AUTO_REPLY", "UNSUBSCRIBE"] },
      bodyText: { not: null },
    },
    orderBy: { repliedAt: "desc" },
    take: opts.limit ?? 25,
    select: { id: true },
  });

  const done = new Set(
    (
      await db.need.findMany({
        where: { businessId, sourceMessageId: { in: inbound.map((m) => m.id) } },
        select: { sourceMessageId: true },
      })
    ).map((n) => n.sourceMessageId!),
  );

  const results: ExtractResult[] = [];
  for (const m of inbound) {
    if (done.has(m.id)) continue;
    try {
      results.push(await extractFromReply(businessId, m.id));
    } catch (e) {
      results.push({
        needId: null,
        companyName: "?",
        status: "SKIPPED",
        costUsd: 0,
        why: e instanceof Error ? e.message.slice(0, 140) : "failed",
      });
    }
  }
  return results;
}
