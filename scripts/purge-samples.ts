/**
 * Removes every fabricated record: companies on the reserved .test TLD (created
 * by the simulated hunter) and the seeded demo supplier catalogue.
 *
 * Real scraped data is identified by having a routable domain, so it is never
 * touched. Safe to re-run.
 *
 *   npm run db:purge-samples
 */
import { db } from "../src/lib/db";

const fake = await db.company.findMany({
  where: { primaryDomain: { endsWith: ".test" } },
  select: { id: true },
});
const ids = fake.map((c) => c.id);

if (ids.length) {
  // Messages and matches hang off prospects/contacts; clear them before the
  // companies so nothing is orphaned by a cascade that does not reach them.
  await db.message.deleteMany({ where: { OR: [
    { contact: { companyId: { in: ids } } },
    { match: { prospect: { companyId: { in: ids } } } },
  ] } });
  await db.match.deleteMany({ where: { prospect: { companyId: { in: ids } } } });
  await db.prospect.deleteMany({ where: { companyId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: ids } } });
}

// The seeded catalogue: fabricated products for a fabricated business.
const demoSuppliers = ["ChocoLux Singapore", "Bloomhaus Florals", "Marque Engraving Studio", "Aperture Dev Studio"];
const sup = await db.supplier.findMany({ where: { name: { in: demoSuppliers } }, select: { id: true } });
const supIds = sup.map((s) => s.id);
if (supIds.length) {
  await db.message.deleteMany({ where: { match: { product: { supplierId: { in: supIds } } } } });
  await db.match.deleteMany({ where: { product: { supplierId: { in: supIds } } } });
  await db.supplierProduct.deleteMany({ where: { supplierId: { in: supIds } } });
  await db.supplier.deleteMany({ where: { id: { in: supIds } } });
}

// Anything left over from simulated agent runs.
await db.agentRun.deleteMany({ where: { model: "simulated" } });
await db.offering.deleteMany({});

const [co, pr, su, pd, ru] = await Promise.all([
  db.company.count(), db.prospect.count(), db.supplier.count(),
  db.supplierProduct.count(), db.agentRun.count(),
]);
console.log(`purged ${ids.length} simulated companies, ${supIds.length} demo suppliers`);
console.log(`remaining: ${co} companies · ${pr} prospects · ${su} suppliers · ${pd} products · ${ru} agent runs`);
await db.$disconnect();
