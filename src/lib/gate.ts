import { createHash } from "node:crypto";
import type { Channel } from "@prisma/client";
import { db } from "@/lib/db";
import { getEmailAdapter } from "@/adapters/email";
import { accessTokenFor, activeMailbox } from "@/lib/gmail-auth";

/**
 * THE SEND GATE
 *
 * Every outbound message goes through here. There is no other path to a
 * provider. See docs/01-architecture.md §7 and docs/04-compliance.md.
 *
 * The bulk test is the one that matters for volume sending. Singapore's Spam
 * Control Act 2007 deems messages "sent in bulk" above 100 of the SAME OR
 * SIMILAR SUBJECT MATTER in 24h (1,000/30d, 10,000/yr) - and bulk unsolicited
 * commercial email must carry an <ADV> subject prefix plus a full unsubscribe
 * facility. Genuinely individual emails land in different content buckets and
 * do not aggregate, which is why per-company tailoring is a compliance
 * mechanism here and not just a performance trick.
 */

export type GateDecision = {
  allowed: boolean;
  reasons: string[];
  advApplied: boolean;
  contentGroupId: string;
  counts?: { h24: number; d30: number; d365: number };
};

const salt = () => process.env.HASH_SALT ?? "dev-salt-change-me";
export const hashValue = (v: string) => createHash("sha256").update(salt() + v.trim().toLowerCase()).digest("hex");

/**
 * The "same or similar subject matter" bucket. Strips the parts that vary per
 * recipient - names, companies, numbers - so a single blasted template collapses
 * to one bucket while genuinely distinct emails do not.
 */
export function contentGroupId(subject: string, body: string): string {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b\d[\d,.]*\b/g, "#")
      .replace(/[^a-z#\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .sort()
      .slice(0, 40)
      .join(" ");
  return createHash("sha256").update(normalise(subject) + "|" + normalise(body.slice(0, 600))).digest("hex").slice(0, 32);
}

const ADV_PREFIX = "<ADV> ";

export async function sendThroughGate(messageId: string): Promise<GateDecision> {
  const msg = await db.message.findUniqueOrThrow({
    where: { id: messageId },
    include: {
      contact: true,
      business: { include: { sendPolicy: true, region: true } },
      mailbox: true,
    },
  });

  const reasons: string[] = [];
  const policy = msg.business.sendPolicy;
  const to = msg.contact?.email;
  const groupId = contentGroupId(msg.subject ?? "", msg.bodyText ?? "");

  const block = async (reason: string, decision: Partial<GateDecision> = {}) => {
    reasons.push(reason);
    const d: GateDecision = { allowed: false, reasons, advApplied: false, contentGroupId: groupId, ...decision };
    await db.message.update({
      where: { id: messageId },
      data: { status: "BLOCKED_BY_GATE", blockedReason: reason, gateDecision: d as object },
    });
    await db.auditLog.create({
      data: { businessId: msg.businessId, actorType: "system", action: "gate.blocked", entityType: "message", entityId: messageId, after: d as object },
    });
    return d;
  };

  // 1. recipient exists
  if (!to) return block("No email address on the contact.");

  // 2. suppression - business scope and global, by address and by domain
  const domain = to.split("@")[1]?.toLowerCase();
  const suppressed = await db.suppressionEntry.findFirst({
    where: {
      OR: [
        { scope: "GLOBAL", OR: [{ email: to }, { emailHash: hashValue(to) }, { domain }] },
        { scope: "BUSINESS", businessId: msg.businessId, OR: [{ email: to }, { emailHash: hashValue(to) }, { domain }] },
      ],
    },
  });
  if (suppressed) return block(`Suppressed (${suppressed.reason}).`);

  // 3. provenance - ADR-003. No source, no send.
  if (msg.contact && !msg.contact.sourceUrl && msg.contact.verification === "UNVERIFIED") {
    return block("Contact has no recorded source. Unsourced contacts cannot be emailed.");
  }
  if (msg.contact && !msg.contact.isBusinessContactInfo) {
    return block("Not business contact information — outside the PDPA business-contact exclusion.");
  }

  // 4. prior negative reply on this contact
  const negative = await db.message.findFirst({
    where: { contactId: msg.contactId, direction: "INBOUND", replyClass: { in: ["NEGATIVE", "UNSUBSCRIBE"] } },
  });
  if (negative) return block("This contact previously replied negatively or opted out.");

  // 5. channel rules
  if (msg.channel !== "EMAIL") {
    const rule = await db.complianceRule.findFirst({
      where: { regionId: msg.business.regionId, channel: msg.channel as Channel, key: "dnc_check_required" },
    });
    if (rule) return block(`${msg.channel} requires a Do Not Call check, which is not implemented.`);
  }

  // 6. bulk thresholds
  const now = Date.now();
  const since = (ms: number) => new Date(now - ms);
  const [h24, d30, d365] = await Promise.all([
    db.sendLedgerEntry.count({ where: { businessId: msg.businessId, contentGroupId: groupId, sentAt: { gte: since(864e5) } } }),
    db.sendLedgerEntry.count({ where: { businessId: msg.businessId, contentGroupId: groupId, sentAt: { gte: since(30 * 864e5) } } }),
    db.sendLedgerEntry.count({ where: { businessId: msg.businessId, contentGroupId: groupId, sentAt: { gte: since(365 * 864e5) } } }),
  ]);
  const counts = { h24, d30, d365 };
  const limits = {
    h24: policy?.bulkPer24h ?? 100,
    d30: policy?.bulkPer30d ?? 1000,
    d365: policy?.bulkPer365d ?? 10000,
  };
  const wouldCross = h24 + 1 > limits.h24 || d30 + 1 > limits.d30 || d365 + 1 > limits.d365;

  let advApplied = false;
  let subject = msg.subject ?? "";
  let bodyText = msg.bodyText ?? "";

  if (wouldCross) {
    if ((policy?.onThresholdCross ?? "block") === "block") {
      const ordinal = (n: number) => {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
      };
      return block(
        `This would be the ${ordinal(h24 + 1)} message with the same subject matter in 24h (limit ${limits.h24}). ` +
          `Sending it makes this a bulk campaign, which legally requires an <ADV> subject prefix. ` +
          `Tailor the copy, split the batch, or switch this business to EDM mode.`,
        { counts },
      );
    }
    // EDM mode: comply rather than block.
    advApplied = true;
    if (!subject.startsWith(ADV_PREFIX)) subject = ADV_PREFIX + subject;
  }

  // 7. rate limits
  if (policy?.dailySendCap) {
    const sentToday = await db.message.count({
      where: { businessId: msg.businessId, direction: "OUTBOUND", status: "SENT", sentAt: { gte: since(864e5) } },
    });
    if (sentToday >= policy.dailySendCap) {
      return block(`Daily send cap reached (${policy.dailySendCap}).`, { counts });
    }
  }

  // 8a. a real sender identity is not optional
  //
  // This used to fall back to "noreply@example.test" when no sender email was
  // configured. That is worse than not sending: the recipient cannot reply, the
  // Spam Control Act requires a working contact address on commercial email,
  // and a message from a fake domain damages the sending reputation of every
  // message after it. Refuse instead.
  const fromEmail = policy?.senderContactEmail ?? msg.mailbox?.address ?? null;
  if (!fromEmail) {
    return block(
      "No sender address configured. Set a reply-to on the send policy before sending — " +
        "commercial email must carry a working contact address.",
      { counts },
    );
  }

  // 8b. unsubscribe + sender identity, always
  //
  // Reply-based rather than a hosted link, deliberately.
  //
  // The Second Schedule requires "a working unsubscribe facility, which must
  // itself carry an email address and a telephone or fax number for submitting
  // the request" — so an address the recipient can reply to IS the facility the
  // Act contemplates, not a workaround for one.
  //
  // The hosted link was worse on both counts. It was built from NEXTAUTH_URL,
  // which is localhost, so it was unreachable by every recipient: a facility
  // that exists and cannot be used is not a working facility. And a tracking
  // URL in a one-to-one email reads as a mass campaign, which is exactly what
  // this outreach is not.
  const unsubEmail = policy?.senderContactEmail ?? fromEmail;
  const unsubPhone = policy?.senderContactPhone;
  const unsubMailto = `mailto:${unsubEmail}?subject=${encodeURIComponent("Unsubscribe")}`;

  if (policy?.alwaysIncludeUnsubscribe !== false || advApplied) {
    // At bulk volume the facility must carry BOTH an address and a number.
    // Below the threshold that requirement is not triggered, so a missing phone
    // is not a reason to refuse an individually-written email.
    if (advApplied && !unsubPhone) {
      return block(
        "This send crosses the bulk threshold, where the law requires the unsubscribe facility to carry " +
          "both an email address and a telephone number. No sender phone is set on the send policy.",
        { counts },
      );
    }

    const contactLine = [policy?.senderName, unsubEmail, unsubPhone].filter(Boolean).join(" · ");
    const how = unsubPhone
      ? `To stop receiving these, reply with "unsubscribe" or call ${unsubPhone} and I'll remove you.`
      : `To stop receiving these, reply with "unsubscribe" and I'll remove you.`;
    bodyText += `\n\n—\n${contactLine || msg.business.name}\n${how}`;
  }

  // 9. send, then commit message + ledger + audit together
  //
  // The access token is resolved and refreshed here rather than read from
  // credentialRef. That column holds an encrypted blob containing a refresh
  // token, and the access token inside it expires after an hour — passing it
  // straight through worked during setup and would have failed silently the
  // next day.
  let accessToken: string | undefined;
  if ((process.env.EMAIL_ADAPTER ?? "mock") === "gmail") {
    const mailbox = msg.mailbox ?? (await activeMailbox(msg.businessId));
    if (!mailbox) {
      return block("EMAIL_ADAPTER=gmail but no Gmail mailbox is connected. Connect one in Settings.", { counts });
    }
    try {
      accessToken = await accessTokenFor(mailbox.id);
    } catch (e) {
      return block(`Gmail authorisation failed: ${e instanceof Error ? e.message : "unknown"}`, { counts });
    }
    if (!msg.mailboxId) await db.message.update({ where: { id: messageId }, data: { mailboxId: mailbox.id } });
  }

  const adapter = getEmailAdapter({ accessToken });
  const sent = await adapter.send({
    to,
    toName: msg.contact?.fullName,
    fromName: policy?.senderName ?? msg.business.name,
    fromEmail,
    subject,
    text: bodyText,
    // mailto rather than https: it matches the facility named in the footer,
    // and gives Gmail a native one-click unsubscribe that actually reaches an
    // inbox we read, instead of a localhost URL that reaches nobody.
    headers: {
      "List-Unsubscribe": `<${unsubMailto}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });

  const decision: GateDecision = { allowed: true, reasons: ["passed"], advApplied, contentGroupId: groupId, counts };

  await db.$transaction([
    db.message.update({
      where: { id: messageId },
      data: {
        status: "SENT",
        sentAt: new Date(),
        subject,
        bodyText,
        advPrefixApplied: advApplied,
        unsubscribeUrl: unsubMailto,
        providerMessageId: sent.providerMessageId,
        providerThreadId: sent.providerThreadId,
        gateDecision: decision as object,
      },
    }),
    db.sendLedgerEntry.create({
      data: {
        businessId: msg.businessId,
        messageId,
        channel: msg.channel,
        contentGroupId: groupId,
        recipientHash: hashValue(to),
      },
    }),
    db.auditLog.create({
      data: {
        businessId: msg.businessId,
        actorType: "system",
        action: "message.sent",
        entityType: "message",
        entityId: messageId,
        after: { provider: sent.provider, advApplied, contentGroupId: groupId } as object,
      },
    }),
  ]);

  // A probe counts as "asked" only once it has actually gone out. Marking the
  // need PROBED at draft time would inflate the denominator of probe reply
  // rate - the single number this whole model is judged on - with questions
  // nobody ever received.
  try {
    const { markProbed } = await import("@/lib/demand/probe");
    await markProbed(messageId);
  } catch (e) {
    console.error("[gate] could not mark need as probed:", e instanceof Error ? e.message : e);
  }

  return decision;
}

/** Dry run for the UI: what would happen to this batch, without sending. */
export async function previewBatch(businessId: string, messageIds: string[]) {
  const msgs = await db.message.findMany({
    where: { id: { in: messageIds } },
    select: { id: true, subject: true, bodyText: true },
  });
  const groups = new Map<string, number>();
  for (const m of msgs) {
    const g = contentGroupId(m.subject ?? "", m.bodyText ?? "");
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  const policy = await db.sendPolicy.findUnique({ where: { businessId } });
  const limit = policy?.bulkPer24h ?? 100;
  const largest = Math.max(0, ...groups.values());
  return {
    total: msgs.length,
    distinctGroups: groups.size,
    largestGroup: largest,
    limit,
    wouldTriggerAdv: largest > limit,
  };
}
