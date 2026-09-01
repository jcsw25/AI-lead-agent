import { db } from "@/lib/db";
const c = await db.company.findFirstOrThrow({
  where: { name: { contains: "Residential Repairs", mode: "insensitive" } },
  select: { name: true, description: true, websiteUrl: true, industry: true },
});
console.log(`name:        ${c.name}`);
console.log(`site:        ${c.websiteUrl}`);
console.log(`description: ${c.description ?? "(none)"}`);

const runs = await db.agentRun.findMany({
  where: { agent: "SUPPLIER_RECRUITER", status: "SUCCEEDED" },
  orderBy: { startedAt: "desc" }, take: 3,
  select: { input: true, output: true },
});
for (const r of runs) {
  const i = r.input as { supplierName?: string; verifiedFacts?: string[] };
  const o = r.output as { claimsMade?: string[] };
  console.log(`\n${i.supplierName}`);
  console.log(`  facts given:  ${(i.verifiedFacts ?? []).join(" | ").slice(0, 200) || "(none)"}`);
  console.log(`  claims made:  ${(o.claimsMade ?? []).join(" | ").slice(0, 200) || "(none)"}`);
}
await db.$disconnect();
