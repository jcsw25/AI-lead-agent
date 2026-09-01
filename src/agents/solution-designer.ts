import { z } from "zod/v4";
import { type AgentDef, runAgent } from "./runtime";
import { db } from "@/lib/db";
import { commissionFor } from "./matchmaker";

/**
 * SOLUTION DESIGNER
 *
 * Turns discovery-call notes into a scoped engagement. This is the step that
 * makes a developer introduction worth a commission: nobody buys engineering
 * from a cold email, they buy it after a conversation that named their problem
 * correctly and proposed a first phase small enough to say yes to.
 *
 * The binding constraint: every phase must trace to a problem the prospect
 * actually stated on the call. Solutions invented for problems nobody raised
 * are how services proposals get ignored.
 */

const Phase = z.object({
  name: z.string(),
  description: z.string(),
  days: z.number(),
  deliverable: z.string(),
});

const Input = z.object({
  companyName: z.string(),
  companyContext: z.string(),
  employeeBand: z.string().optional(),
  callNotes: z.string(),
  problemsStated: z.array(z.string()),
  systemsMentioned: z.array(z.string()),
  budgetSignal: z.string().optional(),
  timelineSignal: z.string().optional(),
  serviceName: z.string(),
  serviceDescription: z.string().optional(),
  rateType: z.string(),
  rateMin: z.number().nullable(),
  rateMax: z.number().nullable(),
  supplierName: z.string(),
  supplierSkills: z.array(z.string()),
  currency: z.string(),
});

const Output = z.object({
  title: z.string(),
  summary: z.string(),
  /** Each entry must quote the problem as the prospect described it. */
  problemsAddressed: z.array(
    z.object({
      problem: z.string(),
      evidenceFromCall: z.string(),
      solution: z.string(),
    }),
  ),
  phases: z.array(Phase).min(1),
  risks: z.array(z.object({ risk: z.string(), mitigation: z.string() })),
  estimatedDays: z.number(),
  estimatedValue: z.number(),
  /** Things you could not scope without more information - stated, not hidden. */
  openQuestions: z.array(z.string()),
});

const SYSTEM = `You scope a technical engagement from discovery-call notes.

Hard rules:
- Every problem in problemsAddressed MUST be one the prospect actually raised on the call,
  with evidenceFromCall quoting or closely paraphrasing what they said. Never introduce a
  problem they did not mention, however obvious it seems to you.
- Phase 1 must be small enough to approve without a procurement process - days, not months.
  A large first phase is the most common reason technical proposals stall.
- Every phase needs a concrete deliverable the client can inspect. "Discovery" is not a
  deliverable; "a documented process map and a costed automation shortlist" is.
- estimatedValue must follow from the rate and the days. Show the arithmetic in summary.
- If the notes are too thin to scope responsibly, say so: return one short discovery phase
  and put the gaps in openQuestions. Do not pad a proposal to look thorough.
- Name risks honestly, including ones that argue against the engagement (their data may be
  worse than described, a key person may be unavailable). A proposal with no risks reads
  as a sales document, and technical buyers discount it accordingly.
- No adjectives about the supplier. Describe what will be built and what it will cost.`;

const agent: AgentDef<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: "SOLUTION_DESIGNER",
  model: "claude-opus-5",
  effort: "high",
  input: Input,
  output: Output,
  system: SYSTEM,
  user: (i) => `Client: ${i.companyName}${i.employeeBand ? ` (${i.employeeBand} employees)` : ""}
Context: ${i.companyContext}

DISCOVERY CALL NOTES
${i.callNotes}

Problems they stated:
${i.problemsStated.map((p) => `- ${p}`).join("\n") || "(none captured)"}
Systems mentioned: ${i.systemsMentioned.join(", ") || "none"}
Budget signal: ${i.budgetSignal ?? "none given"}
Timeline signal: ${i.timelineSignal ?? "none given"}

DELIVERY
Service: ${i.serviceName}${i.serviceDescription ? ` — ${i.serviceDescription}` : ""}
Supplier: ${i.supplierName} (skills: ${i.supplierSkills.join(", ")})
Rate: ${i.currency} ${i.rateMin ?? "?"}–${i.rateMax ?? "?"} ${i.rateType}`,
  mock: (i) => {
    const rate = i.rateType === "DAY_RATE" ? (i.rateMin ?? 1200) : 0;
    const days = 3;
    const value = rate ? rate * days : (i.rateMin ?? 4500);
    return {
      title: `${i.serviceName} — ${i.companyName}`,
      summary: `Simulated proposal. A ${days}-day first phase to confirm and cost the problems raised on the call, delivered by ${i.supplierName}. ${rate ? `${days} days × ${i.currency} ${rate} = ${i.currency} ${value}.` : `Fixed fee ${i.currency} ${value}.`} No model was called — add ANTHROPIC_API_KEY for a real scope.`,
      problemsAddressed: i.problemsStated.slice(0, 3).map((p) => ({
        problem: p,
        evidenceFromCall: "Stated on the discovery call.",
        solution: "Would be scoped from the call notes by the solution designer.",
      })),
      phases: [
        {
          name: "Phase 1 — Audit",
          description: "Map the manual processes named on the call, measure time lost, and cost the fixes.",
          days,
          deliverable: "Process map and a costed shortlist, ranked by hours saved per dollar.",
        },
      ],
      risks: [
        { risk: "Data quality may be worse than described on the call.", mitigation: "Phase 1 inspects real data before any build is quoted." },
        { risk: "Simulated scope — not based on a real conversation.", mitigation: "Re-run with an API key once real call notes exist." },
      ],
      estimatedDays: days,
      estimatedValue: value,
      openQuestions: [
        "Who owns the systems involved, and who signs off?",
        "Is there a deadline forcing this, or is it discretionary?",
      ],
    };
  },
};

export async function runSolutionDesigner(businessId: string, callId: string) {
  const call = await db.discoveryCall.findUniqueOrThrow({
    where: { id: callId },
    include: {
      prospect: { include: { company: true, business: { include: { region: true } } } },
      match: { include: { product: { include: { supplier: true } } } },
    },
  });

  const product = call.match?.product;
  if (!product) throw new Error("This call is not linked to a matched service — match one first.");

  const problems = Array.isArray(call.problemsIdentified)
    ? (call.problemsIdentified as Array<{ problem?: string }>).map((p) => p.problem ?? String(p))
    : [];

  const { output, runId, simulated } = await runAgent(
    agent,
    {
      companyName: call.prospect.company.name,
      companyContext: call.prospect.company.description ?? "No description recorded.",
      employeeBand: call.prospect.company.employeeBand ?? undefined,
      callNotes: call.notes,
      problemsStated: problems,
      systemsMentioned: call.systemsMentioned,
      budgetSignal: call.budgetSignal ?? undefined,
      timelineSignal: call.timelineSignal ?? undefined,
      serviceName: product.name,
      serviceDescription: product.description ?? undefined,
      rateType: product.rateType,
      rateMin: product.priceMin ? Number(product.priceMin) : null,
      rateMax: product.priceMax ? Number(product.priceMax) : null,
      supplierName: product.supplier.name,
      supplierSkills: product.skills,
      currency: call.prospect.business.region.currency,
    },
    { businessId },
  );

  const model = product.supplier.isSelf ? "NONE" : product.supplier.defaultCommissionModel;
  const rate = product.supplier.defaultCommissionRate ? Number(product.supplier.defaultCommissionRate) : null;

  const proposal = await db.solutionProposal.create({
    data: {
      businessId,
      prospectId: call.prospectId,
      matchId: call.matchId,
      discoveryCallId: call.id,
      title: output.title,
      summary: output.summary,
      problemsAddressed: output.problemsAddressed,
      phases: output.phases,
      risks: [...output.risks, ...output.openQuestions.map((q) => ({ risk: `Open question: ${q}`, mitigation: "Confirm before Phase 2." }))],
      estimatedDays: output.estimatedDays,
      estimatedValue: output.estimatedValue,
      estimatedCommission: commissionFor(model, rate, output.estimatedValue),
      currency: product.currency,
      agentRunId: runId,
    },
  });

  // The proposal is a better estimate than the pre-call guess — update the match.
  if (call.matchId) {
    await db.match.update({
      where: { id: call.matchId },
      data: {
        estimatedDealValue: output.estimatedValue,
        estimatedCommission: commissionFor(model, rate, output.estimatedValue),
        status: "NEGOTIATING",
      },
    });
  }
  await db.activity.create({
    data: {
      prospectId: call.prospectId,
      type: "proposal",
      summary: `Solution scoped: ${output.title} — ${output.estimatedDays} days, ${product.currency} ${output.estimatedValue.toLocaleString()}`,
    },
  });

  return { proposalId: proposal.id, simulated };
}

export const solutionDesigner = agent;
