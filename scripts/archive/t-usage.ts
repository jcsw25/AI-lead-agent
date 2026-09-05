import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const rows: Array<[string, number, string]> = [
  ["Opportunity Centre (/)", await db.company.count(), "home dashboard"],
  ["Generator", await db.scrapeRun.count({ where: { businessId: biz.id, mode: "search" } }), "searches run"],
  ["Industries", await db.industryPlay.count({ where: { businessId: biz.id } }), "industry plays"],
  ["Pairings", await db.pairing.count({ where: { businessId: biz.id } }), "pairings"],
  ["Supplier leads", await db.supplierLead.count({ where: { businessId: biz.id } }), "legacy SupplierLead rows"],
  ["Qualified", await db.qualification.count({ where: { businessId: biz.id } }), "qualifications"],
  ["Introductions", await db.introduction.count({ where: { businessId: biz.id } }), "introductions"],
  ["Needs", await db.need.count({ where: { businessId: biz.id } }), "needs"],
  ["Matchmake", await db.matchmake.count({ where: { businessId: biz.id } }), "matchmakes"],
  ["Prospects", await db.prospect.count({ where: { businessId: biz.id } }), "prospects"],
  ["Approvals", await db.message.count({ where: { businessId: biz.id, status: "DRAFT" } }), "drafts"],
  ["Replies", await db.message.count({ where: { businessId: biz.id, status: "SENT" } }), "sent messages"],
  ["Outreach", await db.match.count({ where: { businessId: biz.id } }), "Match rows (legacy path)"],
  ["Suppliers", await db.supplier.count({ where: { businessId: biz.id } }), "suppliers"],
  ["Agent runs", await db.agentRun.count({ where: { businessId: biz.id } }), "agent runs"],
];
for (const [name, n, what] of rows) console.log(`  ${String(n).padStart(5)}  ${name.padEnd(24)} ${what}`);
await db.$disconnect();
