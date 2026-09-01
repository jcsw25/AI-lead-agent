import { db } from "../src/lib/db";
import { getSearchAdapters } from "../src/adapters/search";
import { registrableDomain } from "../src/lib/domain";

const industry = process.argv[2] ?? "aircon servicing";
const limit = Number(process.argv[3] ?? 100);
const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" }, include: { region: true } });

const known = new Set(
  (await db.company.findMany({ select: { primaryDomain: true } }))
    .map(c => c.primaryDomain).filter((d): d is string => Boolean(d))
);
const before = await db.company.count();

const found = new Map<string, { name: string; website?: string; phone?: string }>();
for (const a of getSearchAdapters()) {
  if (found.size >= limit) break;
  try {
    for (const t of await a.discover(industry, biz.region.name, limit, { exclude: known })) {
      const k = registrableDomain(t.website ?? "") ?? t.name.toLowerCase();
      if (!found.has(k) && !known.has(k)) found.set(k, t);
    }
  } catch (e) { console.log(`  ${a.name} failed: ${e instanceof Error ? e.message.slice(0,70) : e}`); }
}

let created = 0;
for (const [key, t] of found) {
  const domain = registrableDomain(t.website ?? "");
  if (domain && known.has(domain)) continue;
  const c = await db.company.create({
    data: {
      name: t.name, primaryDomain: domain, websiteUrl: t.website, industry,
      regionId: biz.regionId, countryCode: biz.region.code, city: biz.region.name,
      verification: "INFERRED", lastResearchedAt: new Date(),
    },
  });
  created++;
  if (t.phone) {
    await db.contact.create({ data: {
      companyId: c.id, fullName: `${t.name} (main line)`, jobTitle: "General enquiries",
      phone: t.phone, sourceType: "public_registry", isBusinessContactInfo: true, verification: "INFERRED",
    }});
  }
}
console.log(`${industry}: ${found.size} found · ${created} new · companies ${before} -> ${await db.company.count()}`);
await db.$disconnect();
