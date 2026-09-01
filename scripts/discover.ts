import { PrismaClient } from "@prisma/client";
import { discoverForPairing } from "../src/scraper/discover";

const db = new PrismaClient();
const term = process.argv[2] ?? "laundry";
const limit = Number(process.argv[3] ?? 12);

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
const pairing = await db.pairing.findFirstOrThrow({
  where: { businessId: biz.id, supplierIndustry: { contains: term, mode: "insensitive" } },
});
console.log(`Pairing: ${pairing.supplierIndustry}\n     -> ${pairing.buyerIndustry}\n`);

const r = await discoverForPairing(biz.id, pairing.id, { limit, side: "A" });
console.log(JSON.stringify(r, null, 1));
await db.$disconnect();
