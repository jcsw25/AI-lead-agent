import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";
import { registrableDomain } from "@/lib/domain";

/**
 * PROSPECT HUNTER
 *
 * Takes an accepted industry play and finds real companies inside it, plus the
 * people who hold the budget. Discovery is web-search driven (no registry
 * dependency) - see ADR-005.
 *
 * Hard rule enforced in the post-processor, not the prompt: a candidate with no
 * source is DISCARDED. A hallucinated company list is worse than an empty one,
 * because it looks like progress.
 */

const Contact = z.object({
  fullName: z.string(),
  jobTitle: z.string(),
  department: z.string().optional(),
  seniority: z.enum(["C_LEVEL", "VP", "DIRECTOR", "MANAGER", "IC"]).optional(),
  email: z.string().optional(),
  linkedinUrl: z.string().optional(),
  sourceUrl: z.string().optional(),
  /** Why this person, for this deal - not a generic title match. */
  rationale: z.string(),
});

const Candidate = z.object({
  name: z.string(),
  domain: z.string(),
  websiteUrl: z.string().optional(),
  description: z.string(),
  industry: z.string().optional(),
  employeeBand: z.string().optional(),
  city: z.string().optional(),
  whyItFits: z.string(),
  buyingSignal: z.string().optional(),
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })),
  contacts: z.array(Contact),
});

const Input = z.object({
  industry: z.string(),
  thesis: z.string(),
  buyingTrigger: z.string(),
  reachVia: z.array(z.string()),
  motion: z.string(),
  regionName: z.string(),
  limit: z.number().max(50),
  excludeDomains: z.array(z.string()),
});

const Output = z.object({
  companies: z.array(Candidate),
  notes: z.array(z.string()),
});

const SYSTEM = `You find real companies inside a target industry, and the people who hold the
budget for a specific kind of purchase.

Rules:
- Every company MUST have at least one source URL you actually consulted. If you cannot
  source it, do not include it. An empty list is a valid answer.
- Prefer the company's own website for firmographics and named people. Do not guess emails;
  return an email only if it is published. Omit the field otherwise - a role-based contact
  route is better than a fabricated address.
- Only business contact information published in a business capacity. No personal addresses.
- contacts[].rationale must say why THIS person for THIS purchase, not restate their title.
- whyItFits must be specific to the company, not a restatement of the industry thesis.
- buyingSignal only if you found a real, dated, sourced event. Omit it otherwise.
- Quality over quantity. Returning 8 well-sourced companies beats 40 guesses.`;

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "PROSPECT_HUNTER",
  model: "claude-sonnet-5",
  effort: "medium",
  input: Input,
  output: Output,
  system: SYSTEM,
  tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 12 }],
  user: (i) => `Industry: ${i.industry}
Market: ${i.regionName}
Motion: ${i.motion}
Why this industry buys: ${i.thesis}
Why now: ${i.buyingTrigger}
Roles that hold the budget: ${i.reachVia.join(", ")}
Return up to ${i.limit} companies.
${i.excludeDomains.length ? `Already known, skip: ${i.excludeDomains.join(", ")}` : ""}`,
  mock: (i) => mockCompanies(i),
};

export async function runProspectHunter(businessId: string, playId: string, limit = 8) {
  const play = await db.industryPlay.findUniqueOrThrow({ where: { id: playId } });
  const business = await db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { region: true },
  });

  const known = await db.prospect.findMany({
    where: { businessId },
    select: { company: { select: { primaryDomain: true } } },
  });

  const { output, runId, simulated } = await runAgent(
    agent,
    {
      industry: play.industry,
      thesis: play.thesis,
      buyingTrigger: play.buyingTrigger,
      reachVia: play.reachVia,
      motion: play.motion,
      regionName: business.region.name,
      limit,
      excludeDomains: known.map((k) => k.company.primaryDomain).filter((d): d is string => Boolean(d)),
    },
    { businessId },
  );

  let created = 0;
  let skippedNoSource = 0;

  for (const c of output.companies) {
    // The guard that matters: no source, no record.
    if (!c.sources.length) {
      skippedNoSource++;
      continue;
    }
    const domain = registrableDomain(c.domain);
    if (!domain) {
      skippedNoSource++;
      continue;
    }

    const company = await db.company.upsert({
      where: { primaryDomain: domain },
      update: {
        description: c.description,
        industry: c.industry ?? play.industry,
        employeeBand: c.employeeBand,
        city: c.city,
        lastResearchedAt: new Date(),
      },
      create: {
        primaryDomain: domain,
        name: c.name,
        websiteUrl: c.websiteUrl ?? `https://${domain}`,
        description: c.description,
        industry: c.industry ?? play.industry,
        employeeBand: c.employeeBand,
        city: c.city,
        countryCode: business.region.code,
        regionId: business.regionId,
        verification: simulated ? "UNVERIFIED" : "VERIFIED",
        lastResearchedAt: new Date(),
      },
    });

    const existing = await db.prospect.findUnique({
      where: { businessId_companyId: { businessId, companyId: company.id } },
    });
    if (existing) continue;

    const prospect = await db.prospect.create({
      data: {
        businessId,
        companyId: company.id,
        playId: play.id,
        source: simulated ? "hunter (simulated)" : "hunter",
        stage: c.contacts.length ? "CONTACT_IDENTIFIED" : "DISCOVERED",
      },
    });
    created++;

    for (const [idx, ct] of c.contacts.entries()) {
      const contact = await db.contact.upsert({
        where: { companyId_email: { companyId: company.id, email: ct.email ?? `unknown-${idx}@${domain}` } },
        update: {},
        create: {
          companyId: company.id,
          fullName: ct.fullName,
          jobTitle: ct.jobTitle,
          department: ct.department,
          seniority: ct.seniority,
          email: ct.email ?? `unknown-${idx}@${domain}`,
          linkedinUrl: ct.linkedinUrl,
          sourceUrl: ct.sourceUrl ?? c.sources[0]?.url,
          sourceType: "company_website",
          verification: ct.email && !simulated ? "VERIFIED" : "UNVERIFIED",
        },
      });
      await db.prospectContact.upsert({
        where: { prospectId_contactId: { prospectId: prospect.id, contactId: contact.id } },
        update: {},
        create: { prospectId: prospect.id, contactId: contact.id, isPrimary: idx === 0, rationale: ct.rationale },
      });
    }

    if (c.buyingSignal) {
      await db.buyingSignal.create({
        data: {
          companyId: company.id,
          type: "OTHER",
          title: c.buyingSignal,
          observedAt: new Date(),
          expiresAt: new Date(Date.now() + 90 * 864e5),
          strength: 0.6,
          sourceUrl: c.sources[0]?.url,
          verification: simulated ? "UNVERIFIED" : "VERIFIED",
          agentRunId: runId,
        },
      });
    }

    await db.activity.create({
      data: {
        prospectId: prospect.id,
        type: "discovered",
        summary: `Found via industry play "${play.industry}" — ${c.whyItFits}`,
      },
    });
  }

  return { created, skippedNoSource, simulated, notes: output.notes };
}

// ---------------------------------------------------------------------------
// Simulated output. Emails use example.com on purpose: if outreach is ever
// wired to a live sender, sample data cannot reach a real person.
// ---------------------------------------------------------------------------

function mockCompanies(i: z.infer<typeof Input>): z.infer<typeof Output> {
  const slug = i.industry.toLowerCase().replace(/[^a-z]+/g, "").slice(0, 10) || "co";
  const stems = [
    ["Marina Bay", "Group"], ["Raffles Quay", "Partners"], ["Tanjong Pagar", "Holdings"],
    ["Orchard", "Collective"], ["Keppel Bay", "Ventures"], ["Bugis", "Enterprises"],
    ["Novena", "Associates"], ["Jurong", "Industries"],
  ];
  const roles = i.reachVia.length ? i.reachVia : ["Operations Manager"];
  const firsts = ["Wei Ming", "Priya", "Daniel", "Siti", "Rachel", "Arjun", "Mei Ling", "Marcus"];
  const lasts = ["Tan", "Nair", "Lim", "Rahman", "Wong", "Menon", "Chua", "Goh"];

  return {
    companies: stems.slice(0, Math.min(i.limit, stems.length)).map(([a, b], n) => {
      const name = `${a} ${b}`;
      // .test is reserved by RFC 2606: never resolves, and each name is a
      // distinct registrable domain so dedupe treats them as separate companies.
      const domain = `${a.toLowerCase().replace(/\s+/g, "")}-${slug}.test`;
      const role = roles[n % roles.length];
      return {
        name,
        domain,
        websiteUrl: `https://${domain}`,
        description: `Simulated ${i.industry.toLowerCase()} company used to demonstrate the pipeline. No research was performed.`,
        industry: i.industry,
        employeeBand: ["11-50", "51-200", "201-500", "500+"][n % 4],
        city: "Singapore",
        whyItFits: `Matches the play thesis: ${i.thesis.slice(0, 110)}`,
        buyingSignal: n % 3 === 0 ? `${i.buyingTrigger} (simulated — unsourced)` : undefined,
        sources: [{ url: `https://${domain}/about`, title: `${name} — simulated source` }],
        contacts: [
          {
            fullName: `${firsts[n % firsts.length]} ${lasts[n % lasts.length]}`,
            jobTitle: role,
            department: role.split(" ").pop(),
            seniority: (["DIRECTOR", "MANAGER", "VP", "C_LEVEL"] as const)[n % 4],
            email: `${firsts[n % firsts.length].toLowerCase().replace(/\s+/g, ".")}.${lasts[n % lasts.length].toLowerCase()}@${domain}`,
            sourceUrl: `https://${domain}/team`,
            rationale: `Holds the budget for this category — the play identifies ${role} as the decision maker.`,
          },
        ],
      };
    }),
    notes: [
      "Simulated discovery — no web search ran and none of these companies are real.",
      "Contact addresses use the reserved .test domain, so sample data can never reach a real inbox.",
      "Add ANTHROPIC_API_KEY and re-run to search for actual companies.",
    ],
  };
}

export const prospectHunter = agent;
