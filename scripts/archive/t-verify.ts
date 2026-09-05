import { db } from "@/lib/db";
const c = await db.company.findFirstOrThrow({
  where: { primaryDomain: "healthcare.com.sg" },
  select: { id: true, name: true,
    qualifications: { select: { status: true, rejectionReason: true, explanation: true } },
    prospects: { select: { stage: true, disqualifiedReason: true } },
    contacts: { select: { messages: { select: { status: true, blockedReason: true } } } },
    introsAsA: { select: { id: true } }, introsAsB: { select: { id: true } } },
});
console.log(`${c.name} (healthcare.com.sg)`);
console.log(`  qualification  ${c.qualifications[0]?.status} / ${c.qualifications[0]?.rejectionReason}`);
console.log(`  reason         ${c.qualifications[0]?.explanation?.slice(0, 100)}`);
console.log(`  prospect stage ${c.prospects[0]?.stage} (${c.prospects[0]?.disqualifiedReason ?? "-"})`);
console.log(`  introductions  ${c.introsAsA.length + c.introsAsB.length}`);
for (const ct of c.contacts) for (const m of ct.messages) console.log(`  message        ${m.status} — ${m.blockedReason ?? ""}`);
await db.$disconnect();
