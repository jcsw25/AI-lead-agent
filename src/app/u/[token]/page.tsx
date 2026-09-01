import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { hashValue } from "@/lib/gate";

export const dynamic = "force-dynamic";

/**
 * Unsubscribe, confirmed by a click rather than by a page load.
 *
 * This used to opt the recipient out on GET, before rendering. That is wrong
 * for a reason that only shows up in production: Gmail, Outlook and corporate
 * security scanners routinely PREFETCH links in email to check them for
 * malware. Every one of those fetches would have silently unsubscribed a
 * recipient who never clicked anything — and the resulting suppression is
 * permanent and indistinguishable from a real opt-out.
 *
 * It was caught here by an automated check against the URL doing exactly that,
 * to the owner's own address.
 *
 * So the page now only WRITES on a form POST, which scanners do not perform.
 * That is still one click for the recipient, so the facility remains a working
 * one under the Second Schedule; it just cannot be triggered by a machine
 * looking at the link.
 */

async function confirmUnsubscribe(token: string) {
  "use server";
  const msg = await db.message.findFirst({
    where: { unsubscribeUrl: { endsWith: `/u/${token}` } },
    include: { contact: true },
    orderBy: { createdAt: "desc" },
  });
  if (!msg?.contact?.email) return;

  const existing = await db.suppressionEntry.findFirst({
    where: { businessId: msg.businessId, email: msg.contact.email, reason: "UNSUBSCRIBE" },
  });
  if (!existing) {
    await db.suppressionEntry.create({
      data: {
        businessId: msg.businessId,
        scope: "BUSINESS",
        reason: "UNSUBSCRIBE",
        email: msg.contact.email,
        emailHash: hashValue(msg.contact.email),
        sourceMessageId: msg.id,
        note: "Confirmed on the unsubscribe page.",
      },
    });
    await db.prospect.updateMany({
      where: { businessId: msg.businessId, companyId: msg.contact.companyId },
      data: { stage: "SUPPRESSED", disqualifiedReason: "Unsubscribed" },
    });
    await db.auditLog.create({
      data: {
        businessId: msg.businessId,
        actorType: "user",
        action: "contact.unsubscribed",
        entityType: "contact",
        entityId: msg.contactId,
      },
    });
  }
  redirect(`/u/${token}?done=1`);
}

export default async function Unsubscribe({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;

  const msg = await db.message.findFirst({
    where: { unsubscribeUrl: { endsWith: `/u/${token}` } },
    include: { contact: true, business: true },
    orderBy: { createdAt: "desc" },
  });

  const already = msg?.contact?.email
    ? await db.suppressionEntry.findFirst({
        where: { businessId: msg.businessId, email: msg.contact.email, reason: "UNSUBSCRIBE" },
      })
    : null;

  const confirmed = Boolean(done || already);

  return (
    <div style={{ maxWidth: "34rem", margin: "4rem auto", padding: "0 1.5rem" }}>
      {confirmed ? (
        <>
          <h1>You&apos;re unsubscribed</h1>
          <p className="sub">
            {msg?.contact?.email ? (
              <>
                <b>{msg.contact.email}</b> will not receive further email from {msg.business.name}. That took
                effect immediately and nothing else is required from you.
              </>
            ) : (
              "That address has been removed."
            )}
          </p>
        </>
      ) : msg?.contact?.email ? (
        <>
          <h1>Unsubscribe</h1>
          <p className="sub">
            Confirm and <b>{msg.contact.email}</b> will receive no further email from {msg.business.name}.
          </p>
          <form action={confirmUnsubscribe.bind(null, token)}>
            <button type="submit">Unsubscribe me</button>
          </form>
          <p className="muted" style={{ fontSize: "0.84rem", marginTop: "1rem" }}>
            One click, no account needed. You can also simply reply to the email with &ldquo;unsubscribe&rdquo;.
          </p>
        </>
      ) : (
        <>
          <h1>Link not recognised</h1>
          <p className="sub">
            That link has expired or was already used. If you keep receiving email, reply to it with
            &ldquo;unsubscribe&rdquo; and it will be actioned.
          </p>
        </>
      )}
    </div>
  );
}
