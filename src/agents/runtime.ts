import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import type { AgentName } from "@prisma/client";
import { db } from "@/lib/db";

/** USD per million tokens. Keep in sync with docs/01-architecture.md §4. */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/**
 * Adaptive thinking is a 4.6-and-later feature. Sending it to Haiku 4.5 is a
 * hard 400 — "adaptive thinking is not supported on this model" — so a request
 * built for the frontier models silently makes the whole cheap tier unusable.
 * That matters because the tier gate in the intelligence plan puts the highest-
 * volume work on Haiku: without this, the cheapest path is the broken one.
 */
const SUPPORTS_ADAPTIVE_THINKING: Record<string, boolean> = {
  "claude-opus-5": true,
  "claude-sonnet-5": true,
  "claude-haiku-4-5": false,
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentDef<TIn, TOut> = {
  name: AgentName;
  model: keyof typeof PRICING;
  effort?: Effort;
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  /** Stable across calls — cached. Never interpolate volatile values here. */
  system: string;
  user: (input: TIn) => string;
  tools?: Anthropic.Messages.ToolUnion[];
  /**
   * Used when no ANTHROPIC_API_KEY is set, so the whole product is explorable
   * offline. Results are flagged `simulated` and the UI says so — sample data
   * must never be mistaken for a real research result.
   */
  mock: (input: TIn) => TOut;
};

export type RunResult<TOut> = {
  output: TOut;
  runId: string;
  simulated: boolean;
  costUsd: number;
};

export const hasApiKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

function hash(v: unknown): string {
  const s = JSON.stringify(v);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

/**
 * The only path to the model. Validates in and out, records an AgentRun row
 * before the call so crashed runs are visible, and attributes cost.
 */
export async function runAgent<TIn, TOut>(
  agent: AgentDef<TIn, TOut>,
  rawInput: TIn,
  opts: { businessId?: string } = {},
): Promise<RunResult<TOut>> {
  const input = agent.input.parse(rawInput);
  const simulated = !hasApiKey();
  const startedAt = Date.now();

  const run = await db.agentRun.create({
    data: {
      businessId: opts.businessId ?? null,
      agent: agent.name,
      status: "RUNNING",
      model: simulated ? "simulated" : agent.model,
      effort: agent.effort ?? "high",
      inputHash: hash(input),
      input: input as object,
    },
    select: { id: true },
  });

  const fail = async (status: "FAILED" | "REFUSED" | "INVALID_OUTPUT", detail: string, code?: string) => {
    await db.agentRun.update({
      where: { id: run.id },
      data: { status, errorDetail: detail, refusalCategory: code, finishedAt: new Date(), latencyMs: Date.now() - startedAt },
    });
  };

  try {
    if (simulated) {
      const output = agent.output.parse(agent.mock(input));
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: "SUCCEEDED", output: output as object, costUsd: 0, latencyMs: Date.now() - startedAt, finishedAt: new Date() },
      });
      return { output, runId: run.id, simulated: true, costUsd: 0 };
    }

    const client = new Anthropic();
    const adaptive = SUPPORTS_ADAPTIVE_THINKING[agent.model] ?? false;
    const res = await client.messages.parse({
      model: agent.model,
      max_tokens: 16000,
      ...(adaptive ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        ...(adaptive ? { effort: agent.effort ?? "high" } : {}),
        format: zodOutputFormat(agent.output as never),
      },
      system: [{ type: "text", text: agent.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: agent.user(input) }],
      ...(agent.tools ? { tools: agent.tools } : {}),
    });

    if (res.stop_reason === "refusal") {
      const category = res.stop_details?.type === "refusal" ? (res.stop_details.category ?? undefined) : undefined;
      await fail("REFUSED", "Model declined the request.", category ?? undefined);
      throw new Error(`Agent ${agent.name} was refused${category ? ` (${category})` : ""}.`);
    }

    if (!res.parsed_output) {
      await fail("INVALID_OUTPUT", "Response did not match the output schema.");
      throw new Error(`Agent ${agent.name} returned output that failed schema validation.`);
    }

    const u = res.usage;
    const price = PRICING[agent.model];
    const costUsd =
      ((u.input_tokens ?? 0) * price.in + (u.output_tokens ?? 0) * price.out) / 1_000_000;

    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED",
        output: res.parsed_output as object,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? null,
        cacheWriteTokens: u.cache_creation_input_tokens ?? null,
        costUsd,
        latencyMs: Date.now() - startedAt,
        finishedAt: new Date(),
      },
    });

    return { output: res.parsed_output as TOut, runId: run.id, simulated: false, costUsd };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("was refused") && !msg.includes("schema validation")) await fail("FAILED", msg);
    throw e;
  }
}
