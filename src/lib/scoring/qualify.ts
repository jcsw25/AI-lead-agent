import type { RejectionReason } from "@prisma/client";
import { db } from "@/lib/db";
import { extractFeatures } from "./features";
import { activeScoringModel, scoreOne, DEFAULT_WEIGHTS } from "./score";

/**
 * Qualification: the gate between "a company exists" and "worth contacting".
 *
 * Two rules shape this:
 *
 *   1. Hard gates run BEFORE the score. A company with no way to contact it is
 *      not a low-scoring lead, it is not a lead — and letting it through with a
 *      score of 34 pretends there is a decision to make where there isn't one.
 *
 *   2. Rejections are stored, never deleted. A rejected row with a reason stops
 *      the same company being rediscovered and re-crawled next month, and the
 *      distribution of reasons is the most honest feedback the system produces
 *      about whether discovery is finding the right things at all.
 *
 * Qualified companies are promoted to Prospect, which is what the outreach side
 * consumes, and a ScoreSnapshot records the number with its full breakdown.
 */

export type QualifyResult = {
  qualified: number;
  review: number;
  rejected: number;
  byReason: Record<string, number>;
  byGrade: Record<string, number>;
  prospectsCreated: number;
};

/** Score below which a company is not worth outreach even if it passes the gates. */
const QUALIFY_FLOOR = Number(process.env.QUALIFY_FLOOR ?? 45);
const REVIEW_FLOOR = Number(process.env.QUALIFY_REVIEW_FLOOR ?? 35);

export async function qualifyAll(
  businessId: string,
  opts: { companyIds?: string[]; industry?: string } = {},
): Promise<QualifyResult> {
  let companyIds = opts.companyIds;
  if (!companyIds && opts.industry) {
    companyIds = (
      await db.company.findMany({
        where: { industry: { equals: opts.industry, mode: "insensitive" } },
        select: { id: true },
      })
    ).map((c) => c.id);
  }

  const model = await activeScoringModel(businessId);
  const weights = (model.weights as Record<string, number>) ?? DEFAULT_WEIGHTS;
  const all = await extractFeatures(businessId, companyIds);

  const out: QualifyResult = {
    qualified: 0, review: 0, rejected: 0,
    byReason: {}, byGrade: {}, prospectsCreated: 0,
  };

  for (const cf of all) {
    const scored = scoreOne(cf, weights, model);

    // ---- hard gates, before the number matters -------------------------
    let rejection: RejectionReason | null = null;
    if (cf.gates.nonBusiness) rejection = "NOT_A_BUSINESS";
    else if (cf.gates.directorySite) rejection = "AGGREGATOR";
    else if (cf.gates.looksLikeAggregator) rejection = "AGGREGATOR";
    else if (cf.gates.blockedByRobots) rejection = "BLOCKED_BY_ROBOTS";
    else if (!cf.gates.hasContactRoute) rejection = "NO_CONTACT_ROUTE";
    else if (!cf.gates.reachable) rejection = "SITE_UNREACHABLE";
    else if (!cf.gates.hasPairingThesis) rejection = "NO_PAIRING_THESIS";

    const status =
      rejection ? "REJECTED"
      : scored.score >= QUALIFY_FLOOR ? "QUALIFIED"
      : scored.score >= REVIEW_FLOOR ? "REVIEW"
      : "REJECTED";

    // A company that clears every gate but scores too low is still rejected —
    // but for a reason that says so, rather than being mislabelled.
    const reason: RejectionReason | null =
      rejection ?? (status === "REJECTED" ? "MANUAL" : null);

    const explanation = rejection
      ? `Rejected: ${humanReason(rejection, { industry: cf.industry, directoryWhy: cf.gates.directorySite })}. Scored ${scored.score}/100 on the evidence available.`
      : status === "REJECTED"
        ? `Scored ${scored.score}/100, below the ${QUALIFY_FLOOR} threshold. ${scored.explanation}`
        : scored.explanation;

    await db.qualification.upsert({
      where: { businessId_companyId: { businessId, companyId: cf.companyId } },
      create: {
        businessId, companyId: cf.companyId,
        status, grade: scored.grade, score: scored.score,
        rejectionReason: reason,
        factors: scored.factors as object,
        explanation,
        modelVersion: scored.modelVersion,
      },
      update: {
        status, grade: scored.grade, score: scored.score,
        rejectionReason: reason,
        factors: scored.factors as object,
        explanation,
        modelVersion: scored.modelVersion,
      },
    });

    out.byGrade[scored.grade] = (out.byGrade[scored.grade] ?? 0) + 1;

    if (status === "REJECTED") {
      out.rejected++;
      const k = reason ?? "UNKNOWN";
      out.byReason[k] = (out.byReason[k] ?? 0) + 1;

      // A company that was qualified before and is rejected now must not keep
      // its Prospect row. healthcare.com.sg was correctly re-rejected as a
      // directory and still appeared as the second-highest HOT prospect,
      // because the rejection path returned before touching the pipeline —
      // and an email had already been drafted to it.
      await db.prospect.updateMany({
        where: {
          businessId, companyId: cf.companyId,
          stage: { in: ["DISCOVERED", "RESEARCHING", "QUALIFIED", "CONTACT_IDENTIFIED", "QUEUED"] },
        },
        data: { stage: "DISQUALIFIED", disqualifiedReason: reason ?? "rejected on rescore" },
      });

      // Introductions involving a rejected company must not stay open on
      // either side. Ones with no history are removed; ones that have been
      // acted on are discarded with the reason, because deleting a row that
      // someone already worked loses the record that they did.
      const introWhere = {
        businessId,
        OR: [{ companyAId: cf.companyId }, { companyBId: cf.companyId }],
      };
      await db.introduction.deleteMany({
        where: { ...introWhere, status: { in: ["PROPOSED", "APPROVED"] } },
      });
      await db.introduction.updateMany({
        where: { ...introWhere, status: { in: ["A_CONTACTED", "A_AGREED", "B_CONTACTED"] } },
        data: { status: "DISCARDED", lostReason: `Company rejected: ${reason ?? "unqualified"}` },
      });

      // Unsent drafts to a rejected company are cancelled, not left to be
      // approved by someone who trusts the queue.
      const contacts = await db.contact.findMany({ where: { companyId: cf.companyId }, select: { id: true } });
      if (contacts.length) {
        await db.message.updateMany({
          where: {
            businessId,
            contactId: { in: contacts.map((c) => c.id) },
            status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"] },
          },
          data: { status: "CANCELLED", blockedReason: `Company rejected: ${reason ?? "unqualified"}` },
        });
      }
      continue;
    }
    if (status === "REVIEW") out.review++;
    else out.qualified++;

    // ---- promote to the pipeline ---------------------------------------
    const existing = await db.prospect.findUnique({
      where: { businessId_companyId: { businessId, companyId: cf.companyId } },
      select: { id: true, stage: true },
    });

    const prospect = await db.prospect.upsert({
      where: { businessId_companyId: { businessId, companyId: cf.companyId } },
      create: {
        businessId, companyId: cf.companyId,
        stage: status === "QUALIFIED" ? "QUALIFIED" : "RESEARCHING",
        tier: scored.tier, score: scored.score, scoreVersion: scored.modelVersion,
        source: "discovery",
      },
      update: {
        // Never walk a prospect backwards. Something already contacted or
        // replying must not be reset to QUALIFIED by a rescore.
        ...(existing && ["DISCOVERED", "RESEARCHING", "QUALIFIED"].includes(existing.stage)
          ? { stage: status === "QUALIFIED" ? ("QUALIFIED" as const) : ("RESEARCHING" as const) }
          : {}),
        tier: scored.tier, score: scored.score, scoreVersion: scored.modelVersion,
      },
    });
    if (!existing) out.prospectsCreated++;

    await db.scoreSnapshot.create({
      data: {
        prospectId: prospect.id,
        modelId: scored.modelId,
        score: scored.score,
        tier: scored.tier,
        factors: scored.factors as object,
        explanation: scored.explanation,
      },
    });
  }

  return out;
}

function humanReason(r: RejectionReason, cf: { industry: string | null; directoryWhy?: string | null }): string {
  switch (r) {
    case "NOT_A_BUSINESS": return "a regulator, association or government body, not a company that buys or sells";
    case "NO_CONTACT_ROUTE": return "no email or phone found anywhere on the site";
    case "SITE_UNREACHABLE": return "the website could not be opened";
    case "BLOCKED_BY_ROBOTS": return "the site's robots.txt disallows crawling";
    case "AGGREGATOR": return cf.directoryWhy ?? "looks like a directory or marketplace, not an operating company";
    case "NO_PAIRING_THESIS": return `no pairing in the library covers "${cf.industry ?? "unclassified"}", so there is nobody to introduce them to`;
    default: return r.toLowerCase().replace(/_/g, " ");
  }
}
