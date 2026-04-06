/**
 * coordination-synthesizer.ts
 *
 * Makes a single one-shot ClaudeAdapter call with ALL waiting agents' full responses.
 * Uses the same adapter + key-reading mechanism as regular agents — no separate API key config needed.
 *
 * The model reads every agent's output together and produces:
 *   - teamSummary:     what the agents collectively need from the operator (1–2 sentences)
 *   - agentSummaries:  the specific ask for each individual agent (1 sentence each)
 *
 * One batch call beats per-agent calls because:
 *   - The model sees the full picture (e.g. multiple agents asking for repo access → one clear ask)
 *   - It avoids repetitive generic messages when agents have similar asks
 *   - It's cheaper (one call vs. N calls)
 */

import { ClaudeAdapter } from "@acc/adapter-claude";
import { type AgentEvent } from "@acc/adapter-sdk";

import { createId } from "./ids.js";

const SYNTHESIS_MODEL = "claude-haiku-4-5-20251001";
// Only send the tail of long transcripts to keep token cost low.
const TRANSCRIPT_WINDOW = 1_500;

export interface WaitingAgentInput {
  agentId: string;
  agentTitle: string;
  agentRole?: string;
  transcriptContent: string;
}

export interface TeamStatusSynthesis {
  /** 1–2 sentence headline for the team ask card. */
  teamSummary: string;
  /** Keyed by agentTitle → specific 1-sentence ask for that agent. */
  agentSummaries: Record<string, string>;
}

const SYSTEM_PROMPT = `You are an internal coordinator for a multi-agent AI development team.
Your job is to read what waiting agents have written and produce a clear, actionable summary for the human operator.

Rules:
- Be specific about what the agents actually need. Name the specific action, decision, file, credential, or permission required.
- Do NOT use vague phrases like "needs guidance", "awaiting instruction", "paused and waiting".
- If multiple agents need the same thing (e.g. access to a directory), say so once in the team summary.
- Team summary: 1–2 sentences, no bullet points.
- Per-agent summary: 1 sentence, specific to what that agent wrote.
- Reply ONLY with valid JSON matching the schema below. No prose outside the JSON.`;

function buildPrompt(agents: WaitingAgentInput[], workspaceTask?: string): string {
  const lines: string[] = [];

  if (workspaceTask) {
    lines.push(`CURRENT TASK: ${workspaceTask}`, "");
  }

  lines.push("WAITING AGENTS:", "");

  for (const agent of agents) {
    lines.push(`---`);
    lines.push(`Agent: ${agent.agentTitle}`);
    if (agent.agentRole) lines.push(`Role: ${agent.agentRole}`);
    lines.push(`Latest output:`);
    const content = agent.transcriptContent.slice(-TRANSCRIPT_WINDOW).trim();
    lines.push(content || "(no output yet)");
    lines.push("");
  }

  lines.push(`Based on what the agents wrote above, reply with this JSON:`);
  lines.push(`{`);
  lines.push(`  "teamSummary": "<1-2 sentences: what all agents collectively need from the operator>",`);
  lines.push(`  "agentSummaries": {`);
  for (const agent of agents) {
    lines.push(`    "${agent.agentTitle}": "<1 sentence: specific ask for this agent>",`);
  }
  lines.push(`  }`);
  lines.push(`}`);

  return lines.join("\n");
}

export async function synthesizeTeamStatus(
  agents: WaitingAgentInput[],
  workspaceTask?: string,
): Promise<TeamStatusSynthesis | null> {
  if (agents.length === 0) return null;

  // Skip if all agents have empty transcripts — nothing useful to synthesize.
  const hasContent = agents.some((a) => a.transcriptContent.trim().length > 20);
  if (!hasContent) return null;

  // Use ClaudeAdapter directly — same key-reading mechanism as regular agent sessions.
  // If ANTHROPIC_API_KEY is not set, the adapter will throw AdapterConfigurationError
  // which we catch and treat as a graceful no-op.
  const adapter = new ClaudeAdapter();
  const synthId = createId("synthesis");
  let session: { sessionId: string } | null = null;

  try {
    session = await adapter.startSession({
      agentId: synthId,
      model: SYNTHESIS_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      cwd: undefined,
      contextItems: [],
    });

    let output = "";

    const unsubscribe = await adapter.streamEvents({
      sessionId: session.sessionId,
      onEvent: (event: AgentEvent) => {
        const payload = event.payload as { text?: string };
        if (event.type === "OUTPUT_DELTA" && typeof payload.text === "string") {
          output += payload.text;
        }
        if (event.type === "OUTPUT_FINAL" && typeof payload.text === "string") {
          output = payload.text;
        }
      },
    });

    const result = await adapter.sendInput({
      sessionId: session.sessionId,
      input: buildPrompt(agents, workspaceTask),
    });

    await unsubscribe().catch(() => undefined);

    const rawText = (result.assistantText ?? output).trim();
    if (!rawText) return null;

    // Strip markdown code fences if the model wrapped its JSON.
    const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(jsonText) as {
      teamSummary?: unknown;
      agentSummaries?: unknown;
    };

    if (typeof parsed.teamSummary !== "string" || !parsed.teamSummary.trim()) return null;
    if (typeof parsed.agentSummaries !== "object" || parsed.agentSummaries === null) return null;

    const agentSummaries: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed.agentSummaries)) {
      if (typeof val === "string" && val.trim()) {
        agentSummaries[key] = val.trim();
      }
    }

    return {
      teamSummary: parsed.teamSummary.trim(),
      agentSummaries,
    };
  } catch {
    // AdapterConfigurationError (key not set), network error, JSON parse failure
    // — degrade silently so heuristic fallback kicks in.
    return null;
  } finally {
    if (session) {
      await adapter.stop({ sessionId: session.sessionId }).catch(() => undefined);
    }
  }
}
