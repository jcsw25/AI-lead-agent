import { db } from "@/lib/db";
import { runOutreachWriter } from "@/agents/outreach";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const m = await db.match.findFirst({
  where: { businessId: biz.id, product: { supplier: { isSelf: true } } },
  include: { prospect: { include: { company: { select: { name: true } }, contacts: true } },
             product: { select: { name: true } } },
});
if (!m) { console.log("no match"); process.exit(0); }
console.log(`match: ${m.prospect.company.name} <- ${m.product.name}`);
console.log(`prospect contacts linked: ${m.prospect.contacts.length}`);
try {
  await runOutreachWriter(biz.id, m.id);
  console.log("drafted ok");
} catch (e) {
  console.log(`FAILED: ${e instanceof Error ? e.message : e}`);
}
await db.$disconnect();
