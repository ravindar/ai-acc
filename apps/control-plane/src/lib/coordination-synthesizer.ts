/**
 * coordination-synthesizer.ts
 *
 * Makes a single one-shot direct API call with ALL waiting agents' full responses.
 * Reads ACC_COORDINATION_KEY first, falls back to ANTHROPIC_API_KEY.
 *
 * Synthesis is cached per team-ask-ID + agent set so it only runs ONCE per prompt
 * round — not on every 3-second refresh cycle. The cache is invalidated when a new
 * prompt round starts (new teamAskId) or when the set of waiting agents changes.
 */

const SYNTHESIS_MODEL = "claude-haiku-4-5-20251001";
const TRANSCRIPT_WINDOW = 8_000;

import { getPricing } from "@acc/pricing";

export function calcSynthesisCost(inputTokens: number, outputTokens: number): number {
  const pricing = getPricing(SYNTHESIS_MODEL);
  const inputRate = pricing?.inputPerMillion ?? 1.00;
  const outputRate = pricing?.outputPerMillion ?? 5.00;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

/** Last user-actionable warning from the synthesizer. Reset on success, set on known API errors. */
export let lastSynthesisWarning: string | null = null;

export interface WaitingAgentInput {
  agentId: string;
  agentTitle: string;
  agentRole?: string;
  transcriptContent: string;
}

export interface TeamStatusSynthesis {
  teamSummary: string;
  agentSummaries: Record<string, string>;
  /** Tokens consumed by this synthesis call (for usage tracking). */
  inputTokens: number;
  outputTokens: number;
}

// In-memory cache: teamAskId → { result, agentKey }
// Prevents repeated API calls on every 3s refresh while the same agents are waiting.
const synthesisCache = new Map<string, { result: TeamStatusSynthesis; agentKey: string }>();

/** Returns a stable cache key for a set of agents. */
function agentCacheKey(agents: WaitingAgentInput[]): string {
  return agents.map((a) => a.agentId).sort().join(",");
}

/** Check the cache. Returns the cached result if the agent set hasn't changed. */
export function getCachedSynthesis(teamAskId: string, agents: WaitingAgentInput[]): TeamStatusSynthesis | null {
  const entry = synthesisCache.get(teamAskId);
  if (!entry) return null;
  if (entry.agentKey !== agentCacheKey(agents)) return null;
  return entry.result;
}

const SYSTEM_PROMPT = `You are an internal coordinator for a multi-agent AI development team.
Your job is to read what waiting agents have written and produce a clear, actionable summary for the human operator.

Rules:
- Extract the EXACT question or decision the agent is asking. If the agent presented options (a/b/c), reproduce those options clearly.
- Be specific. Name the specific action, decision, file, credential, or permission required.
- Do NOT use vague phrases like "needs guidance", "awaiting instruction", "paused and waiting".
- If multiple agents need the same thing (e.g. access to a directory), say so once in the team summary.
- Team summary: 1–2 sentences covering what all agents collectively need.
- Per-agent summary: Capture the agent's actual question. If they gave the operator explicit choices, include those choices. 2–4 sentences is fine if needed to preserve the question.
- Reply ONLY with valid JSON matching the schema below. No prose outside the JSON.`;

function buildPrompt(agents: WaitingAgentInput[], workspaceTask?: string): string {
  const lines: string[] = [];
  if (workspaceTask) lines.push(`CURRENT TASK: ${workspaceTask}`, "");
  lines.push("WAITING AGENTS:", "");
  for (const agent of agents) {
    lines.push(`---`);
    lines.push(`Agent: ${agent.agentTitle}`);
    if (agent.agentRole) lines.push(`Role: ${agent.agentRole}`);
    lines.push(`Latest output:`);
    lines.push(agent.transcriptContent.slice(-TRANSCRIPT_WINDOW).trim() || "(no output yet)");
    lines.push("");
  }
  lines.push(`Based on what the agents wrote above, reply with this JSON:`);
  lines.push(`{`);
  lines.push(`  "teamSummary": "<1-2 sentences: what all agents collectively need from the operator>",`);
  lines.push(`  "agentSummaries": {`);
  for (const agent of agents) {
    lines.push(`    "${agent.agentTitle}": "<specific ask for this agent — include any choices/options the agent presented>",`);
  }
  lines.push(`  }`);
  lines.push(`}`);
  return lines.join("\n");
}

export async function synthesizeTeamStatus(
  teamAskId: string,
  agents: WaitingAgentInput[],
  workspaceTask?: string,
): Promise<TeamStatusSynthesis | null> {
  if (agents.length === 0) return null;

  const hasContent = agents.some((a) => a.transcriptContent.trim().length > 20);
  if (!hasContent) return null;

  // Return cached result if agent set hasn't changed.
  const cached = getCachedSynthesis(teamAskId, agents);
  if (cached) {
    console.log(`[synthesis] Cache hit for ${teamAskId} — skipping API call`);
    return { ...cached, inputTokens: 0, outputTokens: 0 }; // no new tokens consumed
  }

  const apiKey = (process.env.ACC_COORDINATION_KEY ?? process.env.ANTHROPIC_API_KEY)?.trim();
  if (!apiKey) {
    console.warn("[synthesis] No API key available — set ACC_COORDINATION_KEY or ANTHROPIC_API_KEY. Falling back to heuristics.");
    return null;
  }

  const keySource = process.env.ACC_COORDINATION_KEY ? "ACC_COORDINATION_KEY" : "ANTHROPIC_API_KEY";
  const keyHint = apiKey.slice(0, 12) + "..." + apiKey.slice(-4);
  console.log(`[synthesis] Calling Haiku for ${agents.length} agent(s): ${agents.map((a) => a.agentTitle).join(", ")} (key: ${keyHint} from ${keySource})`);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SYNTHESIS_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildPrompt(agents, workspaceTask) }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.warn(`[synthesis] API returned ${response.status}: ${errBody.slice(0, 200)}`);
      try {
        const errJson = JSON.parse(errBody) as { error?: { message?: string } };
        const msg = errJson.error?.message ?? "";
        if (/credit balance is too low/i.test(msg)) {
          lastSynthesisWarning = "Coordination key account has no credits. Top up at console.anthropic.com → Plans & Billing.";
        } else if (/invalid.*api.*key|authentication/i.test(msg) || response.status === 401) {
          lastSynthesisWarning = "Coordination key is invalid. Update it in Settings.";
        } else if (/rate.?limit/i.test(msg) || response.status === 429) {
          lastSynthesisWarning = "Coordination key is being rate-limited. Summaries will retry.";
        } else {
          lastSynthesisWarning = `Synthesis API error (${response.status}). Falling back to heuristics.`;
        }
      } catch {
        lastSynthesisWarning = `Synthesis API error (${response.status}). Falling back to heuristics.`;
      }
      return null;
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const rawText = data.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
    if (!rawText) { console.warn("[synthesis] Empty response from API"); return null; }

    const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    let parsed: { teamSummary?: unknown; agentSummaries?: unknown };
    try {
      parsed = JSON.parse(jsonText) as { teamSummary?: unknown; agentSummaries?: unknown };
    } catch (parseErr) {
      console.warn("[synthesis] JSON parse failed:", String(parseErr), "raw:", rawText.slice(0, 300));
      return null;
    }

    if (typeof parsed.teamSummary !== "string" || !parsed.teamSummary.trim()) {
      console.warn("[synthesis] Missing teamSummary in response:", rawText.slice(0, 300));
      return null;
    }
    if (typeof parsed.agentSummaries !== "object" || parsed.agentSummaries === null) {
      console.warn("[synthesis] Missing agentSummaries in response");
      return null;
    }

    const agentSummaries: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed.agentSummaries)) {
      if (typeof val === "string" && val.trim()) agentSummaries[key] = val.trim();
    }

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    console.log(`[synthesis] Success — "${parsed.teamSummary.trim().slice(0, 100)}" (${inputTokens}in/${outputTokens}out)`);

    lastSynthesisWarning = null;

    const result: TeamStatusSynthesis = {
      teamSummary: parsed.teamSummary.trim(),
      agentSummaries,
      inputTokens,
      outputTokens,
    };

    // Cache for this team ask + agent set.
    synthesisCache.set(teamAskId, { result, agentKey: agentCacheKey(agents) });

    return result;
  } catch (err) {
    console.warn("[synthesis] Unexpected error:", String(err));
    return null;
  }
}
