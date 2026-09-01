import { db } from "@/lib/db";

/**
 * Where the project actually is, measured rather than remembered.
 *
 * Every number here is a query. A hand-maintained status list drifts from the
 * code within a week and then quietly misleads — which has already happened on
 * this project twice, once with a scoring engine that existed in the schema and
 * had never been wired, and once with a "86 companies found" figure that was
 * true of a test script and of nothing stored.
 */

export type Stage = {
  name: string;
  status: "working" | "partial" | "not_started";
  measured: string;
  note?: string;
};

export type Recommendation = {
  priority: "now" | "next" | "later";
  title: string;
  why: string;
  effort: string;
};

export type ProjectStatus = {
  stages: Stage[];
  spend: { totalUsd: number; byAgent: Array<{ agent: string; runs: number; usd: number }> };
  recommendations: Recommendation[];
  recentRuns: Array<{ when: Date; kind: string; label: string; status: string; detail: string }>;
};

export async function getProjectStatus(businessId: string): Promise<ProjectStatus> {
  const [
    companies, withEmail, withPhone, audited,
    prospects, qualified, introductions, suppliers,
    drafts, sentReal, replies, pairings, noThesis, noContact,
  ] = await Promise.all([
    db.company.count(),
    db.company.count({ where: { contacts: { some: { email: { not: null } } } } }),
    db.company.count({ where: { contacts: { some: { phone: { not: null } } } } }),
    db.siteAudit.count(),
    db.prospect.count({ where: { businessId, stage: { notIn: ["DISQUALIFIED", "SUPPRESSED", "LOST"] } } }),
    db.qualification.count({ where: { businessId, status: "QUALIFIED" } }),
    db.introduction.count({ where: { businessId, status: { in: ["PROPOSED", "APPROVED", "A_AGREED", "B_CONTACTED"] } } }),
    db.supplier.count({ where: { businessId, isActive: true } }),
    db.message.count({ where: { businessId, status: "DRAFT", direction: "OUTBOUND" } }),
    db.message.count({
      where: {
        businessId, status: "SENT", direction: "OUTBOUND",
        contact: { company: { name: { not: { contains: "Self test" } } } },
      },
    }),
    db.message.count({ where: { businessId, direction: "INBOUND" } }),
    db.pairing.count({ where: { businessId, status: { in: ["active", "proposed"] } } }),
    db.qualification.count({ where: { businessId, rejectionReason: "NO_PAIRING_THESIS" } }),
    db.qualification.count({ where: { businessId, rejectionReason: "NO_CONTACT_ROUTE" } }),
  ]);

  const stages: Stage[] = [
    {
      name: "Discovery",
      status: "working",
      measured: `${companies} companies found`,
      note: "Query strategist writes 6-10 phrasings per industry; ~100 companies in under a minute.",
    },
    {
      name: "Enrichment",
      status: "working",
      measured: `${audited} websites opened · ${withEmail} emails · ${withPhone} phones`,
      note: "Runs itself after a search now, rather than waiting to be asked.",
    },
    {
      name: "Scoring and qualification",
      status: "working",
      measured: `${qualified} qualified · ${prospects} in the pipeline`,
      note: "Arithmetic over weighted features. No model assigns a score.",
    },
    {
      name: "Pairings and introductions",
      status: noThesis > 40 ? "partial" : "working",
      measured: `${pairings} theses · ${introductions} introductions`,
      note: noThesis > 0 ? `${noThesis} companies still rejected for having no A→B thesis.` : undefined,
    },
    {
      name: "Supplier onboarding",
      status: suppliers > 0 ? "working" : "not_started",
      measured: `${suppliers} supplier${suppliers === 1 ? "" : "s"} onboarded`,
      note: "Onboarding is what makes the buyer email honest — it can only claim a relationship that exists.",
    },
    {
      name: "Drafting and approval",
      status: "working",
      measured: `${drafts} drafts waiting`,
      note: "Four writers, all behind one mechanical tone and fabrication gate.",
    },
    {
      name: "Sending",
      status: sentReal > 0 ? "working" : "partial",
      measured: sentReal > 0 ? `${sentReal} sent to real companies` : "self-tests only — nothing sent to a real company",
      note: "Gmail connected and verified end to end. Approval is deliberately manual.",
    },
    {
      name: "Replies and learning",
      status: replies > 0 ? "partial" : "not_started",
      measured: `${replies} repl${replies === 1 ? "y" : "ies"} captured`,
      note: "Capture and classification work. Weight refitting needs far more outcomes before it means anything.",
    },
  ];

  // Real spend, from the runs themselves.
  const runs = await db.agentRun.groupBy({
    by: ["agent"],
    where: { businessId },
    _count: { _all: true },
    _sum: { costUsd: true },
  });
  const byAgent = runs
    .map((r) => ({ agent: r.agent as string, runs: r._count._all, usd: Number(r._sum.costUsd ?? 0) }))
    .sort((a, b) => b.usd - a.usd);
  const totalUsd = byAgent.reduce((s, r) => s + r.usd, 0);

  // Recommendations derived from the state above, not from memory.
  const recommendations: Recommendation[] = [];

  if (sentReal === 0) {
    recommendations.push({
      priority: "now",
      title: "Send to one real company",
      why:
        "Everything upstream is built and verified, and not one email has gone to anyone but you. " +
        "Every projection past this point — reply rate, whether the pairing thesis holds, whether the " +
        "tone lands — is a guess until a stranger responds.",
      effort: "minutes, from the approval queue",
    });
  }
  if (noThesis > 40) {
    recommendations.push({
      priority: "now",
      title: `Generate pairings for the ${noThesis} companies with no A→B thesis`,
      why:
        "These are contactable companies rejected only because nothing says who to introduce them to. " +
        "One Opus call covers an industry, and matching afterwards is free.",
      effort: "one model call, about a minute",
    });
  }
  if (noContact > 100) {
    recommendations.push({
      priority: "next",
      title: `Serper Places for the ${noContact} companies with no contact route`,
      why:
        "The single largest rejection reason. Google Maps listings carry a phone number for most local " +
        "operators whose websites publish nothing. Needs a calling workflow to be worth anything, which " +
        "does not exist yet.",
      effort: "one adapter method, plus a way to work phone leads",
    });
  }
  if (replies < 20) {
    recommendations.push({
      priority: "later",
      title: "Leave the learning loop alone until there are outcomes",
      why:
        "Refitting scoring weights needs hundreds of sends before differences mean anything. Fitting on " +
        "a handful would produce confident nonsense.",
      effort: "none — deliberately deferred",
    });
  }
  recommendations.push({
    priority: "next",
    title: "Move off PGlite before this leaves the laptop",
    why:
      "It has failed under load twice, and it only runs while your machine is awake. Neon is a " +
      "connection-string change, and it also lets the unsubscribe page and any scheduled work exist.",
    effort: "an hour, mostly waiting",
  });

  const recent = await db.scrapeRun.findMany({
    where: { businessId },
    orderBy: { startedAt: "desc" },
    take: 8,
    select: { startedAt: true, mode: true, query: true, status: true, targetsAttempted: true, companiesCreated: true },
  });

  return {
    stages,
    spend: { totalUsd, byAgent },
    recommendations,
    recentRuns: recent.map((r) => ({
      when: r.startedAt,
      kind: r.mode,
      label: (r.query ?? "").replace(/^(industry|enrich):\s*/, ""),
      status: r.status,
      detail: `${r.targetsAttempted ?? 0} attempted · ${r.companiesCreated ?? 0} saved`,
    })),
  };
}
