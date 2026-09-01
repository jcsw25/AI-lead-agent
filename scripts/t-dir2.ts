import { isDirectorySite } from "@/lib/entity";
import { db } from "@/lib/db";
console.log("direct:", isDirectorySite("Directory & Resources of healthcare, doctors, beauty care in Singapore"));
const c = await db.company.findFirst({ where: { primaryDomain: "healthcare.com.sg" }, select: { description: true } });
console.log("stored desc:", JSON.stringify(c?.description?.slice(0, 120)));
console.log("on stored:", isDirectorySite(c?.description));
await db.$disconnect();
