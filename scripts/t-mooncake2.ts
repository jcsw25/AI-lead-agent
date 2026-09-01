import { db } from "@/lib/db";
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const cs = await db.company.findMany({
  where: { industry: "mooncake" },
  select: { name: true, primaryDomain: true, qualifications: { where: { businessId: biz.id }, select: { status: true, rejectionReason: true } } },
});
const rejected = cs.filter((c) => c.qualifications[0]?.status === "REJECTED");
const live = cs.filter((c) => c.qualifications[0]?.status !== "REJECTED");
console.log(`mooncake: ${cs.length} saved · ${rejected.length} rejected · ${live.length} still live`);
console.log(`\nrejected as aggregators/media:`);
for (const c of rejected.filter((x) => x.qualifications[0]?.rejectionReason === "AGGREGATOR").slice(0, 10)) {
  console.log(`   ${(c.primaryDomain ?? "").padEnd(28)} ${c.name.slice(0, 34)}`);
}
console.log(`\nstill live (should look like actual mooncake businesses):`);
for (const c of live.slice(0, 10)) console.log(`   ${(c.primaryDomain ?? "").padEnd(28)} ${c.name.slice(0, 34)}`);
await db.$disconnect();
