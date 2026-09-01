import { db } from "@/lib/db";

/**
 * Company-to-company matching.
 *
 * For every pairing whose two industries both exist in the database, pair the
 * companies on side A with the companies on side B and score the fit.
 *
 * The scoring is arithmetic over observable features — ADR-002 applies here as
 * it does to lead scoring. A model may have written the industry-level thesis;
 * it does not get to decide that THIS aircon company should meet THAT clinic.
 * That decision has to be explainable to the person who is about to put their
 * own name on the introduction.
 *
 * Combinatorics are the real constraint: 161 aircon companies x 108 clinics is
 * 17,388 pairs, and almost all of them are noise. Both sides are capped to
 * their best candidates first, so what comes out is a shortlist worth reading
 * rather than an exhaustive cross-product nobody will open.
 */

export type IntroduceResult = {
  pairingsProcessed: number;
  pairingsSkipped: Array<{ pairing: string; why: string }>;
  created: number;
  updated: number;
  byPairing: Array<{ pairing: string; introductions: number; topScore: number }>;
};

/** How many companies per side to consider. Best-first, by qualification score. */
const SIDE_CAP = Number(process.env.INTRO_SIDE_CAP ?? 25);

type Candidate = {
  id: string;
  name: string;
  domain: string | null;
  score: number;
  hasEmail: boolean;
  hasPhone: boolean;
  audit: { score: number; findings: string[]; hasContactForm: boolean } | null;
};

async function candidatesFor(businessId: string, industry: string): Promise<Candidate[]> {
  const rows = await db.company.findMany({
    where: { industry: { equals: industry, mode: "insensitive" } },
    select: {
      id: true, name: true, primaryDomain: true,
      contacts: { select: { email: true, phone: true } },
      siteAudit: { select: { score: true, findings: true, hasContactForm: true, reachable: true } },
      qualifications: { where: { businessId }, select: { score: true, status: true }, take: 1 },
    },
  });

  return rows
    // Only companies the qualifier has actually passed.
    //
    // Two failures made this stricter. First: a company the qualifier rejected
    // stayed in introductions, because the gate only stopped it becoming a
    // Prospect. Second, and worse: an UNQUALIFIED company (no verdict at all)
    // was treated as acceptable, so freight-forwarding directories crawled
    // minutes earlier became top introductions — `shippinggazette.com.sg`, a
    // trade publication, was proposed as a buyer for corporate catering.
    // Silence from the qualifier is not approval.
    .filter((c) => c.qualifications[0] && c.qualifications[0].status !== "REJECTED")
    .map((c) => ({
      id: c.id,
      name: c.name,
      domain: c.primaryDomain,
      score: c.qualifications[0]?.score ?? 0,
      hasEmail: c.contacts.some((x) => x.email),
      hasPhone: c.contacts.some((x) => x.phone),
      audit: c.siteAudit
        ? {
            score: c.siteAudit.score,
            findings: (c.siteAudit.findings as string[] | null) ?? [],
            hasContactForm: c.siteAudit.hasContactForm,
          }
        : null,
    }))
    // Somebody unreachable cannot be introduced to anyone.
    .filter((c) => c.hasEmail || c.hasPhone)
    .sort((a, b) => b.score - a.score)
    .slice(0, SIDE_CAP);
}

export async function buildIntroductions(
  businessId: string,
  opts: { pairingId?: string; perPairing?: number; skipRequalify?: boolean } = {},
): Promise<IntroduceResult> {
  const perPairing = opts.perPairing ?? 40;

  // Score anything that has never been scored, before matching against it.
  //
  // Discovery and enrichment now run themselves, so companies arrive in the
  // database continuously — and a company crawled two minutes ago has no
  // verdict yet. Matching against that set proposed directories and trade
  // publications as buyers. Qualification is deterministic and free, so there
  // is no reason not to bring it up to date first.
  if (!opts.skipRequalify) {
    const unscored = await db.company.findMany({
      where: { qualifications: { none: { businessId } } },
      select: { id: true },
    });
    if (unscored.length) {
      const { qualifyAll } = await import("@/lib/scoring/qualify");
      const r = await qualifyAll(businessId, { companyIds: unscored.map((c) => c.id) });
      console.log(`[match] scored ${unscored.length} new companies first — ${r.rejected} rejected`);
    }
  }

  const pairings = await db.pairing.findMany({
    where: {
      businessId,
      status: { in: ["active", "proposed"] },
      ...(opts.pairingId ? { id: opts.pairingId } : {}),
    },
    orderBy: { score: "desc" },
  });

  const out: IntroduceResult = {
    pairingsProcessed: 0, pairingsSkipped: [], created: 0, updated: 0, byPairing: [],
  };

  for (const p of pairings) {
    const label = `${p.supplierIndustry} → ${p.buyerIndustry}`;
    const [sideA, sideB] = await Promise.all([
      candidatesFor(businessId, p.supplierIndustry),
      candidatesFor(businessId, p.buyerIndustry),
    ]);

    if (!sideA.length || !sideB.length) {
      out.pairingsSkipped.push({
        pairing: label,
        why: !sideA.length && !sideB.length
          ? "neither industry is in the database"
          : !sideA.length
            ? `no contactable companies in "${p.supplierIndustry}"`
            : `no contactable companies in "${p.buyerIndustry}"`,
      });
      continue;
    }

    out.pairingsProcessed++;
    const dealMid = Number(p.typicalDealLow ?? 0) && Number(p.typicalDealHigh ?? 0)
      ? (Number(p.typicalDealLow) + Number(p.typicalDealHigh)) / 2
      : Number(p.typicalDealHigh ?? p.typicalDealLow ?? 0);
    const rate = Number(p.commissionRate ?? 0);

    const scored: Array<{ a: Candidate; b: Candidate; fit: number; factors: object[]; rationale: string; trigger: string | null }> = [];

    for (const a of sideA) {
      for (const b of sideB) {
        if (a.id === b.id) continue; // a company cannot be introduced to itself

        const factors: Array<{ factor: string; rawValue: number; weight: number; contribution: number; evidence: string }> = [];
        const add = (factor: string, rawValue: number, weight: number, evidence: string) =>
          factors.push({ factor, rawValue, weight, contribution: Number((rawValue * weight).toFixed(4)), evidence });

        // Both sides must be reachable, and email beats phone for a first touch.
        const reachA = a.hasEmail ? 1 : 0.5;
        const reachB = b.hasEmail ? 1 : 0.5;
        add("reachBothSides", (reachA + reachB) / 2, 0.3,
          `A: ${a.hasEmail ? "email" : "phone only"}; B: ${b.hasEmail ? "email" : "phone only"}`);

        // Quality of each side, from the qualification score already computed.
        add("sideAQuality", a.score / 100, 0.2, `${a.name} scored ${a.score}/100`);
        add("sideBQuality", b.score / 100, 0.2, `${b.name} scored ${b.score}/100`);

        // The pairing's own confidence in the thesis.
        add("thesisStrength", p.score, 0.15, `pairing scored ${p.score.toFixed(2)}`);

        // A measured weakness on side B is the reason to make the call now.
        const bWeak = b.audit?.findings ?? [];
        const openings = bWeak.length;
        add("buyerOpening", Math.min(1, openings / 3), 0.15,
          openings ? `${b.name}: ${bWeak.slice(0, 2).join("; ")}` : "no measured weakness on the buyer's site");

        const fit = Number(factors.reduce((s, f) => s + f.contribution, 0).toFixed(3));

        const trigger = openings
          ? `${b.name}: ${bWeak[0]}`
          : p.trigger || null;

        scored.push({
          a, b, fit, factors,
          trigger,
          rationale:
            `${a.name} ${lower(p.whatAHas)} ${b.name} ${lower(p.whatBNeeds)}` +
            (openings ? ` Observed on their site: ${bWeak[0]}.` : ""),
        });
      }
    }

    scored.sort((x, y) => y.fit - x.fit);
    const top = scored.slice(0, perPairing);

    for (const s of top) {
      const key = {
        businessId_companyAId_companyBId_pairingId: {
          businessId, companyAId: s.a.id, companyBId: s.b.id, pairingId: p.id,
        },
      };
      const data = {
        fitScore: s.fit,
        factors: s.factors as object,
        rationale: s.rationale,
        trigger: s.trigger,
        estimatedDealValue: dealMid || null,
        commissionRate: rate || null,
        estimatedCommission: dealMid && rate ? Number((dealMid * rate).toFixed(2)) : null,
        currency: p.currency,
      };

      const existing = await db.introduction.findUnique({ where: key, select: { id: true, status: true } });
      if (existing) {
        // Never overwrite a human decision or a live conversation with a rescore.
        if (existing.status === "PROPOSED") {
          await db.introduction.update({ where: { id: existing.id }, data });
          out.updated++;
        }
      } else {
        await db.introduction.create({
          data: { businessId, pairingId: p.id, companyAId: s.a.id, companyBId: s.b.id, ...data },
        });
        out.created++;
      }
    }

    out.byPairing.push({ pairing: label, introductions: top.length, topScore: top[0]?.fit ?? 0 });
  }

  return out;
}

const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
