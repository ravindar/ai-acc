import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";

import { ClaudeAdapter } from "@acc/adapter-claude";
import { CodexAdapter } from "@acc/adapter-codex";
import {
  AdapterConfigurationError,
  type AgentAdapter,
  type AgentEvent,
} from "@acc/adapter-sdk";
import type { TaskPlanningSuggestion } from "@acc/shared-types";

import { createId } from "../lib/ids.js";

const plannerRequestSchema = z.object({
  workspaceId: z.string().min(1),
  provider: z.enum(["codex", "claude"]),
  model: z.string().min(1),
  task: z.string().min(1),
  constraints: z.string().optional(),
});

function normalizeRecommendedProvider(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "codex" || normalized === "openai" || normalized.startsWith("gpt")) {
    return "codex";
  }

  if (normalized === "claude" || normalized === "anthropic" || normalized.includes("sonnet") || normalized.includes("opus")) {
    return "claude";
  }

  return normalized;
}

const plannerSuggestionSchema = z.object({
  summary: z.string().min(1),
  recommendedAgentCount: z.number().int().min(1).max(12),
  coordinationNotes: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  agents: z
    .array(
      z.object({
        role: z.string().min(1),
        objective: z.string().min(1),
        provider: z.preprocess(normalizeRecommendedProvider, z.enum(["codex", "claude"])),
        model: z.string().min(1),
        reasoning: z.string().min(1),
      }),
    )
    .min(1)
    .max(12),
});

function getPlannerAdapter(provider: "codex" | "claude"): AgentAdapter {
  return provider === "codex" ? new CodexAdapter() : new ClaudeAdapter();
}

function extractJsonPayload(rawText: string): unknown {
  const fencedMatch = rawText.match(/```json\s*([\s\S]*?)```/i) ?? rawText.match(/```\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1] ?? rawText;
  const trimmed = candidate.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);

    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }

    throw new Error("Planner response did not contain valid JSON.");
  }
}

function buildPlannerPrompt(input: {
  task: string;
  projectRoot: string;
  sharedContext: string;
  constraints?: string;
}): string {
  const sharedContextSection = input.sharedContext.trim()
    ? input.sharedContext.trim().slice(0, 12_000)
    : "No shared workspace context provided.";
  const constraintsSection = input.constraints?.trim() ? input.constraints.trim() : "No extra constraints provided.";

  return [
    "You are the planning lead for a multi-agent IDE.",
    "Recommend how many agents are needed for the task and which provider/model each agent should use.",
    "Optimize for correctness, coordination overhead, and cost realism.",
    "Prefer the smallest effective team.",
    "Return JSON only with this exact shape:",
    JSON.stringify(
      {
        summary: "string",
        recommendedAgentCount: 3,
        coordinationNotes: ["string"],
        risks: ["string"],
        agents: [
          {
            role: "string",
            objective: "string",
            provider: "codex",
            model: "gpt-5-codex",
            reasoning: "string",
          },
        ],
      },
      null,
      2,
    ),
    `Task:\n${input.task.trim()}`,
    `Project root:\n${input.projectRoot || "Not set"}`,
    `Shared context:\n${sharedContextSection}`,
    `Constraints:\n${constraintsSection}`,
  ].join("\n\n");
}

async function requestPlannerSuggestion(input: {
  provider: "codex" | "claude";
  model: string;
  task: string;
  projectRoot: string;
  sharedContext: string;
  constraints?: string;
}): Promise<TaskPlanningSuggestion> {
  const adapter = getPlannerAdapter(input.provider);
  const session = await adapter.startSession({
    agentId: createId("planner"),
    model: input.model,
    systemPrompt:
      "You produce orchestration plans for a multi-agent coding workspace. Return strict JSON only, with no prose outside the JSON object.",
    cwd: input.projectRoot || undefined,
    contextItems: input.sharedContext.trim()
      ? [
          {
            id: "workspace-shared-context",
            type: "text",
            value: input.sharedContext.trim(),
          },
        ]
      : [],
  });

  let streamedText = "";
  let finalText = "";

  const unsubscribe = await adapter.streamEvents({
    sessionId: session.sessionId,
    onEvent: (event: AgentEvent) => {
      const payload = event.payload as { text?: string };

      if (typeof payload.text !== "string") {
        return;
      }

      if (event.type === "OUTPUT_DELTA") {
        streamedText += payload.text;
      }

      if (event.type === "OUTPUT_FINAL") {
        finalText = payload.text;
      }
    },
  });

  try {
    const result = await adapter.sendInput({
      sessionId: session.sessionId,
      input: buildPlannerPrompt(input),
    });

    const transcript = result.assistantText?.trim() || finalText.trim() || streamedText.trim();

    if (!transcript) {
      throw new Error("Planner returned no output.");
    }

    const parsed = plannerSuggestionSchema.parse(extractJsonPayload(transcript));
    return {
      advisorProvider: input.provider,
      advisorModel: input.model,
      summary: parsed.summary,
      recommendedAgentCount: parsed.recommendedAgentCount,
      coordinationNotes: parsed.coordinationNotes,
      risks: parsed.risks,
      agents: parsed.agents,
      rawResponse: transcript.trim(),
    };
  } finally {
    await unsubscribe().catch(() => undefined);
    await adapter.stop({ sessionId: session.sessionId }).catch(() => undefined);
  }
}

export async function registerPlannerRoutes(app: FastifyInstance): Promise<void> {
  app.post("/planner/suggest", async (request, reply) => {
    const body = plannerRequestSchema.parse(request.body);
    const workspace = await app.acc.repositories.workspaces.findById(body.workspaceId);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    try {
      return {
        suggestion: await requestPlannerSuggestion({
          provider: body.provider,
          model: body.model,
          task: body.task,
          constraints: body.constraints,
          projectRoot: workspace.projectRoot,
          sharedContext: workspace.sharedContext,
        }),
      };
    } catch (error) {
      if (error instanceof AdapterConfigurationError) {
        reply.code(400);
        return {
          error: "Planner unavailable",
          message: error.message,
        };
      }

      if (error instanceof ZodError) {
        reply.code(502);
        return {
          error: "Planner returned invalid output",
          message: "The advisor response could not be parsed into a valid multi-agent plan.",
          issues: error.issues,
        };
      }

      if (error instanceof Error) {
        reply.code(502);
        return {
          error: "Planner request failed",
          message: error.message,
        };
      }

      throw error;
    }
  });
}
