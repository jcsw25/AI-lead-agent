import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const c = await db.company.findFirstOrThrow({
  where: { name: { contains: "Company A (BBQ", mode: "insensitive" } },
  include: { contacts: true, qualifications: { where: { businessId: biz.id } }, siteAudit: true },
});
console.log(`${c.name}`);
console.log(`  domain      ${c.primaryDomain ?? "(none)"}`);
console.log(`  contacts    ${c.contacts.length}  ${c.contacts.map((x) => x.email).join(", ")}`);
console.log(`  siteAudit   ${c.siteAudit ? "yes" : "none"}`);
console.log(`  qualified   ${c.qualifications[0]?.status ?? "NOT SCORED"} / ${c.qualifications[0]?.rejectionReason ?? "-"}`);
console.log(`  why         ${c.qualifications[0]?.explanation?.slice(0, 130) ?? "-"}`);
await db.$disconnect();
