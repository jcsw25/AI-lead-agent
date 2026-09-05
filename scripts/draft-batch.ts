/**
 * Draft the tech offer to every qualified, contactable aircon and HVAC firm.
 *
 *   npx tsx scripts/draft-batch.ts --dry-run
 *   npx tsx scripts/draft-batch.ts --limit 10
 *   npx tsx scripts/draft-batch.ts
 *
 * The pipeline was throttled here and nowhere else: 113 companies were
 * qualified and contactable, 8 had a Match and 4 had a draft — not by any
 * judgement, but because setup-tech-offer.ts was run once with `--draft 4` and
 * caps matches at twice that. This creates the missing matches and drafts them.
 *
 * Nothing is sent. Every draft lands in the approval queue and still needs a
 * human to read it and click.
 */
import { db } from "@/lib/db";
import { runOutreachWriter } from "@/agents/outreach";
import { checkDraft } from "@/lib/outreach/quality";
import { publicUrlConfigured } from "@/lib/public-url";
import { emailWorthyLeak } from "@/scraper/leaks";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const limit = Number(argv[argv.indexOf("--limit") + 1]) || Infinity;

const biz = await db.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

// A draft written now carries whatever PUBLIC_BASE_URL points at, forever. If
// that is localhost the link is dead to every recipient, and the gate will
// refuse to send it — better to say so before spending twenty minutes.
if (publicUrlConfigured() && /localhost|127\.0\.0\.1/.test(process.env.PUBLIC_BASE_URL ?? "")) {
  console.log(
    `PUBLIC_BASE_URL is ${process.env.PUBLIC_BASE_URL} — report links would be dead for every recipient.\n` +
      `Drafting WITHOUT the free-report link. Set a real domain and re-run to include it.\n`,
  );
  delete process.env.PUBLIC_BASE_URL;
}

const supplier = await db.supplier.findFirstOrThrow({
  where: { businessId: biz.id, isSelf: true },
  include: { products: { where: { isActive: true } } },
});

// ---- who is missing a match --------------------------------------------------
const candidates = await db.company.findMany({
  where: {
    OR: [
      { industry: { contains: "aircon", mode: "insensitive" } },
      { industry: { contains: "HVAC", mode: "insensitive" } },
    ],
    qualifications: { some: { businessId: biz.id, status: { not: "REJECTED" } } },
    contacts: { some: { email: { not: null }, NOT: { email: { startsWith: "unknown-" } } } },
    prospects: { some: { businessId: biz.id, stage: { not: "SUPPRESSED" } } },
  },
  select: {
    id: true, name: true,
    siteAudit: {
      select: {
        hasContactForm: true, hasEmailLink: true, hasPhoneLink: true,
        findings: true, reliable: true, leakFindings: true, leakScore: true,
        missingH1: true, noAboveFoldCta: true, formDepthPct: true,
        distinctPrices: true, hasPopup: true,
      },
    },
    contacts: {
      where: { email: { not: null }, NOT: { email: { startsWith: "unknown-" } } },
      orderBy: { verification: "asc" },
      select: { id: true, messages: { where: { direction: "OUTBOUND", status: { notIn: ["CANCELLED", "FAILED"] } }, select: { id: true } } },
    },
    prospects: { where: { businessId: biz.id }, select: { id: true, contacts: { select: { id: true } } }, take: 1 },
  },
});

const free = candidates.filter((c) => !c.contacts.some((ct) => ct.messages.length));
console.log(`${candidates.length} qualified and contactable · ${free.length} with no live message yet\n`);

/** Pick the service that answers the gap we can actually see on their site. */
function chooseProduct(a: (typeof candidates)[number]["siteAudit"]) {
  const byName = (s: string) => supplier.products.find((p) => p.name.toLowerCase().startsWith(s));
  if (!a?.reliable) return byName("automated service") ?? supplier.products[0];
  if (!a.hasContactForm && !a.hasEmailLink && !a.hasPhoneLink) return byName("ai call") ?? supplier.products[0];
  if (!a.hasContactForm) return byName("automated service") ?? supplier.products[0];
  return byName("follow-up") ?? supplier.products[0];
}

let created = 0;
let drafted = 0;
let failed = 0;
const violations: string[] = [];
const targets = free.slice(0, limit === Infinity ? free.length : limit);

for (const [i, c] of targets.entries()) {
  const prospect = c.prospects[0];
  if (!prospect) { failed++; continue; }
  const product = chooseProduct(c.siteAudit);
  const a = c.siteAudit;

  // The writer resolves its recipient through ProspectContact, not through the
  // company. A scraped contact lives on the Company, so without this link every
  // draft fails with "no contact identified" while the address sits right there.
  if (!prospect.contacts.length) {
    await db.prospectContact.create({
      data: {
        prospectId: prospect.id, contactId: c.contacts[0].id, isPrimary: true,
        roleGuess: "gatekeeper", rationale: "Only published contact route on the company site.",
      },
    });
  }

  let match = await db.match.findFirst({
    where: { businessId: biz.id, prospectId: prospect.id, supplierProductId: product.id },
    select: { id: true },
  });

  if (!match) {
    // Only a finding the audit could actually see. On a client-rendered page
    // nothing is asserted missing, so there is no observation to open with and
    // the writer is told to make no claim rather than invent one.
    // Leak findings first, generic audit findings second.
    //
    // Both were available and only the generic one was used, so emails opened
    // with "no enquiry form" — a category — when the same audit had already
    // produced "the enquiry form sits about 91% of the way down the page".
    // The second is checkable in ten seconds and is about money; the first is
    // a fact about a category of website.
    // Phrased from the visitor's seat, not as a verdict on the page. The raw
    // leak finding says "the enquiry form sits about 91% of the way down the
    // page", which is a fact about their website; emailWorthyLeak turns it into
    // what a customer experienced, which is the only version that gets a reply.
    // Technical signals with no meaning to an owner — a missing h1, a pop-up —
    // are dropped rather than reworded.
    const observed = a?.reliable
      ? emailWorthyLeak(
          {
            missingH1: a.missingH1,
            noAboveFoldCta: a.noAboveFoldCta,
            formDepthPct: a.formDepthPct,
            distinctPrices: a.distinctPrices,
            priceExamples: [],
            hasPopup: a.hasPopup,
            carouselHeroNoHeadline: false,
            approxPageLength: 0,
          },
          a.reliable,
        ) ?? ((a.findings as string[] | null) ?? [])[0] ?? null
      : null;
    if (dryRun) { created++; continue; }
    match = await db.match.create({
      data: {
        businessId: biz.id, prospectId: prospect.id, supplierProductId: product.id,
        fitScore: observed ? 0.8 : 0.5,
        rationale: `${c.name} is an operating aircon firm. ${product.name} is the smallest change that would help.`,
        angle: observed ? "observed_gap" : "industry_fit",
        observedPain: observed,
        firstAsk: "a short call about how bookings reach them today",
        estimatedDealValue: product.priceMin,
        commissionModel: "NONE", currency: "SGD", status: "APPROVED",
      },
      select: { id: true },
    });
    created++;
  }

  if (dryRun) continue;

  try {
    await runOutreachWriter(biz.id, match.id);
    drafted++;
    const msg = await db.message.findFirst({
      where: { matchId: match.id, parentMessageId: null, status: { in: ["DRAFT", "PENDING_APPROVAL"] } },
      orderBy: { createdAt: "desc" },
    });
    if (msg) {
      const v = checkDraft(msg.subject ?? "", msg.bodyText ?? "");
      if (v.length) violations.push(`${c.name}: ${v.map((x) => x.rule).join(", ")}`);
    }
  } catch (e) {
    failed++;
    console.log(`  failed ${c.name}: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
  }

  if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${targets.length} · ${drafted} drafted · ${failed} failed`);
}

console.log(`\nmatches created  ${created}`);
console.log(`drafts written   ${drafted}`);
console.log(`failed           ${failed}`);
if (violations.length) {
  console.log(`\n${violations.length} drafts still carry a tone violation after the rewrite pass:`);
  for (const v of violations.slice(0, 15)) console.log(`  ${v}`);
} else if (drafted) {
  console.log(`every draft passed the tone gate clean`);
}
if (dryRun) console.log(`\ndry run — nothing was written`);
await db.$disconnect();
