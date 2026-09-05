import type { ReplyClass } from "@prisma/client";
import { db } from "@/lib/db";
import { getEmailAdapter } from "@/adapters/email";
import { accessTokenFor, activeMailbox } from "@/lib/gmail-auth";
import { suppressContact } from "@/lib/outreach/suppress";
import { extractFromReply, type ExtractResult } from "@/lib/demand/extract";

/**
 * Reading replies back in.
 *
 * This is what makes the system able to learn anything at all. Without it every
 * downstream number — reply rate, which pairings work, whether the scoring
 * predicts anything — is a guess, and the outcome tables stay empty forever.
 *
 * Two rules shape it:
 *
 *   1. An unsubscribe is acted on immediately and unconditionally. It goes to
 *      the suppression list before anything else is recorded, because the
 *      obligation to stop is not contingent on the rest of this working.
 *
 *   2. Classification is by pattern, not by model. A misread "no thanks" that
 *      gets treated as interest wastes a follow-up; a misread unsubscribe is a
 *      compliance failure. Patterns are dumb but auditable, and anything they
 *      cannot classify is left for a human rather than guessed at.
 */

export type PollResult = {
  fetched: number;
  matched: number;
  unsubscribes: number;
  /** Messages from our own address — sent copies, not replies. */
  skippedOwn: number;
  byClass: Record<string, number>;
  unmatched: string[];
  /** What each reply turned out to say, once read. */
  extracted: ExtractResult[];
};

const UNSUBSCRIBE = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bstop (?:emailing|contacting|sending)\b/i,
  /\bdo not (?:contact|email) (?:me|us)\b/i,
  /\bopt(?:ing)? out\b/i,
];

const NEGATIVE = [
  /\bnot interested\b/i,
  /\bno thanks?\b/i,
  /\bwe(?:'re| are) (?:all set|good|covered|sorted)\b/i,
  /\balready have\b/i,
  /\bnot (?:for us|right now|at this time)\b/i,
  /\bno need\b/i,
  /\bpass\b/i,
];

const POSITIVE = [
  /\b(?:yes|sure|happy to|interested|keen)\b/i,
  /\btell me more\b/i,
  /\bsend (?:over|me|the details)\b/i,
  /\bsounds (?:good|interesting)\b/i,
  /\bwhen (?:can|are) (?:you|we)\b/i,
  /\blet'?s (?:chat|talk|speak)\b/i,
  /\bgive me a call\b/i,
];

const AUTO = [
  /\bout of (?:the )?office\b/i,
  /\bauto(?:matic)?[- ]?repl(?:y|ied)\b/i,
  /\bon (?:annual )?leave\b/i,
  /\bdelivery (?:status|has failed)\b/i,
  /\bundeliverable\b/i,
  /\bmailer-daemon\b/i,
];

export function classifyReply(subject: string, text: string): ReplyClass {
  const blob = `${subject}\n${text}`;
  if (UNSUBSCRIBE.some((r) => r.test(blob))) return "UNSUBSCRIBE";
  if (AUTO.some((r) => r.test(blob))) return "AUTO_REPLY";
  if (NEGATIVE.some((r) => r.test(blob))) return "NEGATIVE";
  if (POSITIVE.some((r) => r.test(blob))) return "HOT";
  // UNSURE rather than a guess. A human reads the ambiguous ones — a misread
  // "no thanks" wastes a follow-up, a misread unsubscribe is a compliance failure.
  return "UNSURE";
}

export async function pollReplies(businessId: string): Promise<PollResult> {
  const out: PollResult = {
    fetched: 0, matched: 0, unsubscribes: 0, skippedOwn: 0, byClass: {}, unmatched: [], extracted: [],
  };

  const mailbox = await activeMailbox(businessId);
  if (!mailbox) throw new Error("No Gmail mailbox connected. Connect one in Settings.");

  const token = await accessTokenFor(mailbox.id);
  const adapter = getEmailAdapter({ accessToken: token });
  if (!adapter.fetchSince) throw new Error(`The ${adapter.name} adapter cannot read mail.`);

  const { messages, cursor } = await adapter.fetchSince(mailbox.historyCursor);
  out.fetched = messages.length;

  // Everything this system has sent, so a sent copy sitting in the inbox is
  // never mistaken for an inbound reply.
  const ourMessageIds = new Set(
    (
      await db.message.findMany({
        where: { businessId, direction: "OUTBOUND", providerMessageId: { not: null } },
        select: { providerMessageId: true },
      })
    ).map((x) => x.providerMessageId!),
  );

  for (const m of messages) {
    // Skip copies of messages WE sent — identified by provider id, not by
    // sender address.
    //
    // Filtering on "from == our own address" was the obvious rule and it is
    // wrong: a reply written from that same mailbox is indistinguishable from a
    // sent copy by address alone, so the filter swallowed the genuine reply
    // along with the two sent copies. The provider id is exact — a sent message
    // and a reply to it are different messages however similar the headers look.
    if (ourMessageIds.has(m.providerMessageId)) {
      out.skippedOwn++;
      continue;
    }

    // Whose reply is this? Match on the address we sent to.
    const contact = await db.contact.findFirst({
      where: { email: { equals: m.fromEmail, mode: "insensitive" } },
      select: { id: true, companyId: true, company: { select: { name: true } } },
    });

    if (!contact) {
      out.unmatched.push(m.fromEmail);
      continue;
    }

    // Already recorded? Gmail returns overlapping windows.
    const dupe = await db.message.findFirst({
      where: { businessId, providerMessageId: m.providerMessageId, direction: "INBOUND" },
      select: { id: true },
    });
    if (dupe) continue;

    const replyClass = classifyReply(m.subject, m.text);

    // Suppression first, before anything else can fail.
    if (replyClass === "UNSUBSCRIBE") {
      await suppressContact(businessId, m.fromEmail, "Asked to be removed in a reply.");
      out.unsubscribes++;
    }

    const inbound = await db.message.create({
      data: {
        businessId,
        mailboxId: mailbox.id,
        contactId: contact.id,
        channel: "EMAIL",
        direction: "INBOUND",
        status: "DELIVERED",
        subject: m.subject,
        bodyText: m.text,
        providerMessageId: m.providerMessageId,
        providerThreadId: m.providerThreadId,
        replyClass,
        classifierNotes:
          replyClass === "UNSURE" ? "Could not classify — needs a human." : "Pattern-matched.",
        repliedAt: m.receivedAt,
      },
    });

    // Attribute the reply to the specific email it answers.
    //
    // This was updateMany over every unreplied message to the contact, so one
    // reply marked ALL of them replied — two sends and one reply reported a
    // 100% reply rate. Reply rate is the input the whole learning loop is
    // fitted against, so inflating it corrupts every conclusion drawn later.
    //
    // Gmail's threadId is the reliable link. Where it is missing (older rows,
    // another provider) fall back to the most recent unanswered send, which is
    // the honest best guess rather than all of them.
    const answered =
      (m.providerThreadId &&
        (await db.message.findFirst({
          where: {
            businessId, direction: "OUTBOUND", status: "SENT",
            providerThreadId: m.providerThreadId, repliedAt: null,
          },
          orderBy: { sentAt: "desc" },
          select: { id: true },
        }))) ||
      (await db.message.findFirst({
        where: {
          businessId, contactId: contact.id, direction: "OUTBOUND", status: "SENT", repliedAt: null,
        },
        orderBy: { sentAt: "desc" },
        select: { id: true },
      }));

    if (answered) {
      await db.message.update({ where: { id: answered.id }, data: { repliedAt: m.receivedAt } });
    }

    out.matched++;
    const k = replyClass;
    out.byClass[k] = (out.byClass[k] ?? 0) + 1;

    // Read what they actually said. This runs here rather than on a schedule so
    // a confirmed need exists the moment the reply lands — the value of "they
    // need a supplier now" decays in days, and a nightly job spends the first
    // of them doing nothing.
    //
    // Wrapped because polling must not fail on it. Losing the extraction costs
    // one model call to redo; losing the poll loses the mailbox cursor, and the
    // reply itself would never be recorded at all.
    if (replyClass !== "UNSUBSCRIBE" && replyClass !== "AUTO_REPLY") {
      try {
        out.extracted.push(await extractFromReply(businessId, inbound.id));
      } catch (e) {
        out.extracted.push({
          needId: null, companyName: contact.company.name, status: "SKIPPED", costUsd: 0,
          why: `extraction failed: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`,
        });
      }
    }
  }

  await db.mailbox.update({
    where: { id: mailbox.id },
    data: { historyCursor: cursor, lastSyncedAt: new Date() },
  });

  return out;
}
