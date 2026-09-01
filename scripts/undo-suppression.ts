import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const target = biz.id;
const entries = await db.suppressionEntry.findMany({ where: { businessId: target, email: "jasoncsw25@gmail.com" } });
console.log(`removing ${entries.length} suppression entr${entries.length === 1 ? "y" : "ies"} for the owner's own address`);
console.log(`(created by an automated GET on the unsubscribe URL, not by a request from the recipient)`);
await db.suppressionEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
await db.auditLog.create({
  data: {
    businessId: target, actorType: "system", action: "suppression.reverted",
    entityType: "suppressionEntry", entityId: entries[0]?.id ?? "n/a",
    after: { reason: "Triggered by an automated link check, not a genuine opt-out." } as object,
  },
});
console.log(`remaining suppressions: ${await db.suppressionEntry.count()}`);
await db.$disconnect();
