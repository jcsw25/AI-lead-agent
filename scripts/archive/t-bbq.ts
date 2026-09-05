import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
// Industries already held that fit "operational headcount, runs staff cohesions"
const FIT = ["aircon servicing", "HVAC", "Commercial laundry and linen services", "Commercial cleaning contractors", "commercial printing"];
for (const ind of FIT) {
  const n = await db.company.count({
    where: {
      industry: { equals: ind, mode: "insensitive" },
      contacts: { some: { email: { not: null } } },
      qualifications: { some: { businessId: biz.id, status: { not: "REJECTED" } } },
    },
  });
  if (n) console.log(`  ${String(n).padStart(3)}  ${ind}`);
}
console.log(`\ntotal contactable, non-rejected companies in the database:`);
console.log(`  ${await db.company.count({ where: { contacts: { some: { email: { not: null } } }, qualifications: { some: { businessId: biz.id, status: { not: "REJECTED" } } } } })}`);
await db.$disconnect();
