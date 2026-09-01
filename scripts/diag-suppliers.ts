import { db } from "@/lib/db";
console.log("suppliers        ", await db.supplier.count());
console.log("supplierProducts ", await db.supplierProduct.count());
console.log("pairings         ", await db.pairing.count());
const p = await db.pairing.findMany({ take: 6, select: { supplierIndustry: true, buyerIndustry: true, lane: true, status: true, score: true } });
for (const x of p) console.log(`  ${x.lane.padEnd(11)} ${x.supplierIndustry.slice(0,28).padEnd(30)} -> ${x.buyerIndustry.slice(0,30)}  (${x.status}, ${x.score})`);
await db.$disconnect();
