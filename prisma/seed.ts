/**
 * Seeds the reference data the system cannot run without (region, seasonal
 * calendar, compliance rules, default scoring weights) plus one demo business.
 * Idempotent - safe to re-run.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/** Dated festivals move each year; these are approximate and seeded 3 years out. */
const SG_SEASONS: Array<[string, string, string, number, string[]]> = [
  ["New Year", "01-01", "01-01", 30, ["retail", "hospitality", "corporate"]],
  ["Chinese New Year", "02-17", "02-18", 45, ["retail", "f&b", "corporate", "banking"]],
  ["Valentine's Day", "02-14", "02-14", 42, ["retail", "f&b", "florist", "hospitality"]],
  ["Hari Raya Puasa", "03-20", "03-21", 40, ["retail", "f&b", "corporate"]],
  ["Easter", "04-05", "04-05", 30, ["retail", "hospitality"]],
  ["Mother's Day", "05-10", "05-10", 28, ["retail", "f&b"]],
  ["Father's Day", "06-21", "06-21", 28, ["retail", "f&b"]],
  ["National Day", "08-09", "08-09", 35, ["corporate", "hospitality", "government"]],
  ["Mid-Autumn Festival", "09-25", "09-25", 45, ["f&b", "hospitality", "corporate", "banking"]],
  ["Deepavali", "11-08", "11-08", 40, ["retail", "corporate"]],
  ["Christmas", "12-25", "12-25", 60, ["retail", "corporate", "banking", "hospitality", "professional services"]],
];

async function main() {
  const region = await db.region.upsert({
    where: { code: "SG" },
    update: {},
    create: { code: "SG", name: "Singapore", timezone: "Asia/Singapore", currency: "SGD", locale: "en-SG" },
  });

  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y < thisYear + 3; y++) {
    for (const [name, start, end, lead, tags] of SG_SEASONS) {
      const startsOn = new Date(`${y}-${start}T00:00:00Z`);
      await db.seasonalWindow.upsert({
        where: { regionId_name_startsOn: { regionId: region.id, name, startsOn } },
        update: {},
        create: {
          regionId: region.id,
          name,
          startsOn,
          endsOn: new Date(`${y}-${end}T00:00:00Z`),
          buyingLeadDays: lead,
          relevantTo: tags,
        },
      });
    }
  }

  // Compliance rules as data - see docs/04-compliance.md
  const rules: Array<[string, unknown, string]> = [
    ["bulk_thresholds", { per24h: 100, per30d: 1000, per365d: 10000 }, "Spam Control Act 2007 (SG)"],
    ["requires_adv_prefix_when_bulk", true, "Spam Control Act 2007, Second Schedule"],
    ["requires_unsubscribe_facility", true, "Spam Control Act 2007, Second Schedule"],
  ];
  for (const [key, value, citation] of rules) {
    await db.complianceRule.upsert({
      where: { regionId_channel_key: { regionId: region.id, channel: "EMAIL", key } },
      update: { value: value as object, citation },
      create: { regionId: region.id, channel: "EMAIL", key, value: value as object, citation },
    });
  }
  await db.complianceRule.upsert({
    where: { regionId_channel_key: { regionId: region.id, channel: "PHONE", key: "dnc_check_required" } },
    update: {},
    create: {
      regionId: region.id,
      channel: "PHONE",
      key: "dnc_check_required",
      value: true,
      citation: "PDPA 2012 Part 9 (Do Not Call Registry)",
    },
  });

  // Hand-set starting weights. There is no outcome data to fit from yet.
  await db.scoringModel.upsert({
    where: { businessId_version: { businessId: null as never, version: 1 } },
    update: {},
    create: {
      businessId: null,
      version: 1,
      isActive: true,
      weights: {
        industryFit: 0.15,
        companySize: 0.15,
        signalStrength: 0.2,
        timing: 0.15,
        decisionMaker: 0.1,
        accessibility: 0.1,
        historicalConversion: 0.1,
        competition: 0.05,
      },
    },
  }).catch(async () => {
    const existing = await db.scoringModel.findFirst({ where: { businessId: null, version: 1 } });
    if (!existing) {
      await db.scoringModel.create({
        data: {
          version: 1,
          isActive: true,
          weights: {
            industryFit: 0.15, companySize: 0.15, signalStrength: 0.2, timing: 0.15,
            decisionMaker: 0.1, accessibility: 0.1, historicalConversion: 0.1, competition: 0.05,
          },
        },
      });
    }
  });

  // Demo business
  const user = await db.user.upsert({
    where: { email: "demo@example.com" },
    update: {},
    create: { email: "demo@example.com", name: "Demo User" },
  });

  let business = await db.business.findFirst({});
  if (!business) {
    business = await db.business.create({
      data: {
        name: process.env.BUSINESS_NAME ?? "My Business",
        websiteUrl: null,
        regionId: region.id,
        members: { create: { userId: user.id, role: "owner" } },
        sendPolicy: { create: {} },
        offerings: {
          create: [
            { name: "Artisanal chocolate boxes", priceMin: 25, priceMax: 80, currency: "SGD", tags: ["retail", "gift"] },
            { name: "Corporate gift hampers", priceMin: 60, priceMax: 150, currency: "SGD", minOrderQty: 50, tags: ["corporate", "bulk"] },
            { name: "Custom-branded gift boxes", priceMin: 45, priceMax: 120, currency: "SGD", minOrderQty: 100, tags: ["corporate", "branded"] },
          ],
        },
        profile: {
          create: {
            industry: "Premium confectionery",
            positioning: "Belgian cocoa, custom branding, same-day delivery in Singapore",
            advantages: ["Belgian cocoa sourcing", "Custom-branded packaging", "Same-day Singapore delivery", "Bulk production capacity"],
            whatWeSell: { summary: "Premium chocolates, gift boxes and corporate hampers", categories: ["retail gifting", "corporate gifting"] },
            analysedAt: new Date(),
          },
        },
      },
    });
  }

  // ---- supply side ---------------------------------------------------------
  // Demo catalogue is OFF by default. It exists to make the UI explorable before
  // you have real suppliers, and becomes noise the moment you do.
  // Enable with:  SEED_DEMO=1 npm run db:seed
  if (!process.env.SEED_DEMO) {
    const seasons = await db.seasonalWindow.count();
    const rules = await db.complianceRule.count();
    console.log(
      `Seeded reference data only: region ${region.code}, ${seasons} seasonal windows, ${rules} compliance rules, ` +
        `business "${business.name}". Set SEED_DEMO=1 to also load the sample supplier catalogue.`,
    );
    return;
  }

  // One "self" supplier (our own catalogue) plus partners we broker for. The
  // matchmaker treats them identically; only the commission terms differ.
  const suppliers: Array<{
    name: string;
    isSelf: boolean;
    model: "PERCENT" | "NONE";
    rate: number | null;
    contact?: string;
    products: Array<{
      name: string; description: string; min: number; max: number;
      moq?: number; unit?: string; idealFor: string[];
    }>;
  }> = [
    {
      name: "ChocoLux Singapore",
      isSelf: true,
      model: "NONE",
      rate: null,
      products: [
        { name: "Corporate gift hampers", description: "Belgian chocolate hampers with custom branding and bulk delivery.", min: 60, max: 150, moq: 50, unit: "per hamper", idealFor: ["banking", "professional services", "corporate", "property"] },
        { name: "Custom-branded gift boxes", description: "Logo-embossed boxes, 8 or 16 piece, produced in 10 working days.", min: 45, max: 120, moq: 100, unit: "per box", idealFor: ["banking", "technology", "events", "hospitality"] },
        { name: "Artisanal retail boxes", description: "Retail-ready assortments for resale or in-room amenity.", min: 25, max: 80, moq: 24, unit: "per box", idealFor: ["hospitality", "retail", "florist"] },
      ],
    },
    {
      name: "Bloomhaus Florals",
      isSelf: false,
      model: "PERCENT",
      rate: 15,
      contact: "partners@bloomhaus.example.com",
      products: [
        { name: "Luxury bouquet programme", description: "Weekly or event-based floral supply with branded wrap.", min: 90, max: 320, moq: 10, unit: "per arrangement", idealFor: ["hospitality", "property", "banking", "florist"] },
        { name: "Event floral installations", description: "Launch and gala installations, design and teardown included.", min: 1800, max: 12000, unit: "per event", idealFor: ["events", "property", "hospitality"] },
      ],
    },
    {
      name: "Marque Engraving Studio",
      isSelf: false,
      model: "PERCENT",
      rate: 12,
      contact: "hello@marque.example.com",
      products: [
        { name: "Custom engraving & branded packaging", description: "Laser engraving and bespoke packaging for gift programmes.", min: 8, max: 45, moq: 100, unit: "per unit", idealFor: ["banking", "professional services", "technology", "corporate"] },
      ],
    },
  ];

  for (const s of suppliers) {
    let supplier = await db.supplier.findFirst({ where: { businessId: business.id, name: s.name } });
    if (!supplier) {
      supplier = await db.supplier.create({
        data: {
          businessId: business.id,
          name: s.name,
          isSelf: s.isSelf,
          contactEmail: s.contact,
          defaultCommissionModel: s.model,
          defaultCommissionRate: s.rate,
        },
      });
    }
    for (const p of s.products) {
      const exists = await db.supplierProduct.findFirst({ where: { supplierId: supplier.id, name: p.name } });
      if (exists) continue;
      await db.supplierProduct.create({
        data: {
          supplierId: supplier.id,
          name: p.name,
          description: p.description,
          priceMin: p.min,
          priceMax: p.max,
          minOrderQty: p.moq,
          unit: p.unit,
          currency: "SGD",
          idealFor: p.idealFor,
          tags: s.isSelf ? ["own"] : ["partner"],
        },
      });
    }
  }

  // ---- services supply ------------------------------------------------------
  // Brokering expertise rather than goods. Priced per engagement, matched on
  // observable pain rather than industry fit, and sold via a discovery call.
  let dev = await db.supplier.findFirst({ where: { businessId: business.id, name: "Aperture Dev Studio" } });
  if (!dev) {
    dev = await db.supplier.create({
      data: {
        businessId: business.id,
        name: "Aperture Dev Studio",
        isSelf: false,
        contactEmail: "intros@aperture.example.com",
        notes: "Two senior engineers. Automation, integrations, internal tooling. Take referrals at 15%.",
        defaultCommissionModel: "PERCENT",
        defaultCommissionRate: 15,
      },
    });
  }

  const services: Array<{
    name: string; description: string; min: number; max: number;
    rateType: "PROJECT" | "DAY_RATE" | "RETAINER"; days?: number;
    skills: string[]; pain: string[]; idealFor: string[];
  }> = [
    {
      name: "Automation audit",
      description: "Three days on site mapping manual processes, then a costed list of what to automate first.",
      min: 4500, max: 4500, rateType: "PROJECT", days: 3,
      skills: ["process mapping", "workflow analysis"],
      pain: ["hiring data entry or admin staff", "spreadsheet-driven operations", "manual reconciliation", "staff copying between systems"],
      idealFor: ["logistics", "professional services", "healthcare", "property", "manufacturing", "retail"],
    },
    {
      name: "Workflow automation build",
      description: "Build and deploy the automations the audit identified. Typically 4-10 weeks.",
      min: 12000, max: 60000, rateType: "PROJECT", days: 40,
      skills: ["Python", "TypeScript", "API integration", "RPA"],
      pain: ["repetitive manual work", "double data entry", "overtime on routine tasks", "error-prone manual processes"],
      idealFor: ["logistics", "professional services", "healthcare", "insurance", "manufacturing"],
    },
    {
      name: "Systems integration",
      description: "Connect systems that do not talk to each other - CRM, accounting, inventory, ops.",
      min: 8000, max: 45000, rateType: "PROJECT", days: 25,
      skills: ["API integration", "ETL", "middleware"],
      pain: ["disconnected systems", "manual export and import", "reporting takes days", "no single source of truth"],
      idealFor: ["logistics", "retail", "hospitality", "professional services", "property"],
    },
    {
      name: "Tech stack modernisation",
      description: "Migrate legacy systems without stopping the business. Phased, with rollback at each step.",
      min: 25000, max: 150000, rateType: "PROJECT", days: 80,
      skills: ["legacy migration", "cloud architecture", "database migration"],
      pain: ["legacy stack in job ads", "unsupported software versions", "cannot hire for their stack", "system outages"],
      idealFor: ["banking", "insurance", "logistics", "manufacturing", "healthcare"],
    },
    {
      name: "Fractional senior developer",
      description: "A senior engineer embedded two to three days a week. No hiring risk, no recruiter fee.",
      min: 1200, max: 1800, rateType: "DAY_RATE", days: 40,
      skills: ["full stack", "architecture", "technical leadership"],
      pain: ["failed developer hire", "long open engineering role", "founder writing the code", "no technical lead"],
      idealFor: ["technology", "professional services", "retail", "property"],
    },
  ];

  for (const s of services) {
    const exists = await db.supplierProduct.findFirst({ where: { supplierId: dev.id, name: s.name } });
    if (exists) continue;
    await db.supplierProduct.create({
      data: {
        supplierId: dev.id,
        name: s.name,
        description: s.description,
        kind: "SERVICE",
        rateType: s.rateType,
        priceMin: s.min,
        priceMax: s.max,
        currency: "SGD",
        unit: s.rateType === "DAY_RATE" ? "per day" : s.rateType === "RETAINER" ? "per month" : "per project",
        typicalEngagementDays: s.days,
        skills: s.skills,
        painSignals: s.pain,
        idealFor: s.idealFor,
        tags: ["partner", "service"],
      },
    });
  }

  const productCount = await db.supplierProduct.count();
  console.log(
    `Seeded. Region ${region.code}, business "${business.name}" (${business.id}), ` +
      `${suppliers.length} suppliers, ${productCount} products.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
