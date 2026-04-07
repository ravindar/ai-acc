import type {
  AgentRunRecord,
  AgentSessionRecord,
  ApprovalRequestRecord,
  ApprovalStatus,
  CoordinationActionRequestRecord,
  CoordinationAgentBriefRecord,
  CoordinationBriefRecord,
  CoordinationDependencyEdge,
  CoordinationFindingType,
  CoordinationFindingSummaryRecord,
  CoordinationHandoffSummaryRecord,
  CoordinationStateRecord,
  CoordinationTeamAskRecord,
  CoordinatorDecisionType,
  HandoffItemRecord,
  HandoffStatus,
  PlannerAgentRecommendation,
  RenderedCoordinationPacketRecord,
  ToolCallStatus,
  TranscriptEntryRecord,
  WorkspaceRecord,
} from "@acc/shared-types";

import { createId } from "./ids.js";
import type { Repositories } from "./repositories.js";
import { synthesizeTeamStatus } from "./coordination-synthesizer.js";
import type { WaitingAgentInput } from "./coordination-synthesizer.js";

function normalizeLabel(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncateText(value: string | undefined, limit = 220): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function summarizeText(value: string | undefined, limit = 180): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  const paragraph = normalized.split(/\n\s*\n/)[0]?.trim() ?? normalized;
  const sentence = paragraph.split(/(?<=[.?!])\s+/)[0]?.trim() ?? paragraph;
  return truncateText(sentence || paragraph || normalized, limit);
}

/**
 * Matches that identify an explicit question or approval/input request.
 * Checked ANYWHERE in the line/sentence (not just at the start).
 */
const EXPLICIT_ASK_PATTERNS = [
  /\?$/,                          // line ends with a question mark
  /\bplease\s+confirm\b/i,        // "please confirm so I may proceed"
  /\bplease\s+provide\b/i,        // "please provide access"
  /\bplease\s+approve\b/i,        // "please approve"
  /\bplease\s+grant\b/i,          // "please grant access"
  /\bplease\s+let\s+me\s+know\b/i,
  /\bif\s+(you\s+)?(approve|confirm|grant|allow)\b/i,  // "if you approve", "if approval is granted"
  /\b(approval|permission|access)\s+(is\s+)?(needed|required|requested)\b/i,
  /\bi\s+need\s+(your\s+)?(approval|permission|access|confirmation|direction)\b/i,
  /\bwaiting\s+(for|on)\s+(your\s+)?(approval|confirmation|input|direction)\b/i,
  /\b(should|shall)\s+i\s+(proceed|continue|begin|start)\b/i,
  /\bdo\s+you\s+(want|prefer|approve|confirm)\b/i,
  /\bwould\s+you\s+(like|prefer)\b/i,
  /\blet\s+me\s+know\b/i,
  /\bif\s+you('d|\s+would)\s+like\b/i,
  /\btell\s+me\s+(which|what|how|whether)\b/i,
  /\b(choose|pick|select|decide|confirm|reply\s+with)\b/i,
];

function matchesExplicitAsk(text: string): boolean {
  const cleaned = text.replace(/\*\*/g, "").replace(/#{1,6}\s*/g, "").trim();
  return EXPLICIT_ASK_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function extractActionRequestFromText(value: string | undefined): string | null {
  const normalized = (value ?? "").replace(/\r/g, "").trim();
  if (!normalized) return null;

  // 1. Scan lines in reverse — prefer the last explicit request the agent wrote.
  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Skip markdown decorators and bullet markers — they're not standalone questions.
    if (/^#{1,6}\s/.test(line) || /^[-*•]\s/.test(line) || /^\d+\.\s/.test(line)) continue;
    if (matchesExplicitAsk(line) && line.length > 10) {
      return truncateText(line, 200);
    }
  }

  // 2. Scan sentences in reverse (catches multi-line sentences not split by \n).
  const sentences = normalized
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i]!;
    if (matchesExplicitAsk(sentence) && sentence.length > 10) {
      return truncateText(sentence, 200);
    }
  }

  return null;
}

/**
 * When no explicit question/directive is found, return the last substantive paragraph
 * so the operator can at least see where the agent stopped, not just a generic placeholder.
 */
function extractLastStatement(value: string | undefined): string | null {
  const normalized = (value ?? "").replace(/\r/g, "").trim();
  if (!normalized) return null;

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const para = paragraphs[i]!;
    // Skip code blocks, pure bullet lists, and markdown headers — show prose instead.
    if (para.startsWith("```") || /^#{1,6}\s/.test(para)) continue;
    // If paragraph is mostly bullets, try to grab a leading sentence instead.
    const stripped = para.replace(/^[-*•]\s.*/gm, "").trim();
    const prose = stripped.length > 30 ? stripped : para;
    if (prose.length > 20) return truncateText(prose, 200);
  }
  return null;
}

function compareIsoDescending(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function roleFromMetadata(agent: AgentSessionRecord): string | undefined {
  return typeof agent.metadata.role === "string" && agent.metadata.role.trim().length > 0
    ? agent.metadata.role.trim()
    : undefined;
}

function executionRootForAgent(agent: AgentSessionRecord, workspace: WorkspaceRecord): string {
  const metadataCwd =
    typeof agent.metadata.cwd === "string" && agent.metadata.cwd.trim().length > 0
      ? agent.metadata.cwd.trim()
      : undefined;

  return agent.worktree?.path || metadataCwd || workspace.projectRoot || "";
}

function findRecommendationByLabel(
  brief: CoordinationBriefRecord | null,
  ...labels: Array<string | undefined>
): PlannerAgentRecommendation | null {
  if (!brief) {
    return null;
  }

  const keys = uniqueStrings(labels.map((label) => normalizeLabel(label)).filter(Boolean));

  if (keys.length === 0) {
    return null;
  }

  const exactMatch = brief.agents.find((recommendation) =>
    keys.includes(normalizeLabel(recommendation.role)),
  );

  if (exactMatch) {
    return exactMatch;
  }

  return (
    brief.agents.find((recommendation) => {
      const recommendationKey = normalizeLabel(recommendation.role);
      return keys.some(
        (key) =>
          recommendationKey.includes(key) ||
          key.includes(recommendationKey),
      );
    }) ?? null
  );
}

function findMatchingRecommendation(
  agent: AgentSessionRecord,
  brief: CoordinationBriefRecord | null,
): PlannerAgentRecommendation | null {
  return findRecommendationByLabel(brief, agent.title, roleFromMetadata(agent));
}

function findMatchingRecommendationOrder(
  agent: AgentSessionRecord,
  brief: CoordinationBriefRecord | null,
): number | undefined {
  if (!brief) {
    return undefined;
  }

  const keys = uniqueStrings(
    [agent.title, roleFromMetadata(agent)].map((label) => normalizeLabel(label)).filter(Boolean),
  );

  if (keys.length === 0) {
    return undefined;
  }

  const exactIndex = brief.agents.findIndex((recommendation) =>
    keys.includes(normalizeLabel(recommendation.role)),
  );

  if (exactIndex >= 0) {
    return exactIndex;
  }

  const fuzzyIndex = brief.agents.findIndex((recommendation) => {
    const recommendationKey = normalizeLabel(recommendation.role);
    return keys.some((key) => recommendationKey.includes(key) || key.includes(recommendationKey));
  });

  return fuzzyIndex >= 0 ? fuzzyIndex : undefined;
}

function summarizeHandoff(handoff: HandoffItemRecord): CoordinationHandoffSummaryRecord {
  return {
    id: handoff.id,
    sourceAgentId: handoff.sourceAgentId,
    sourceRunId: handoff.sourceRunId,
    assignedAgentId: handoff.assignedAgentId,
    title: handoff.title,
    summary: handoff.summary,
    nextPrompt: handoff.nextPrompt,
    recommendedProvider: handoff.recommendedProvider,
    recommendedModel: handoff.recommendedModel,
    artifactIds: handoff.artifactIds,
    status: handoff.status,
    updatedAt: handoff.updatedAt,
  };
}

function summarizeApprovalRequest(approval: ApprovalRequestRecord): string {
  return approval.reason?.trim()
    ? summarizeText(approval.reason, 180)
    : `Approval required for ${approval.requestedAction}.`;
}

function detailApprovalRequest(approval: ApprovalRequestRecord): string | undefined {
  const payloadKeys = Object.keys(approval.requestedPayload ?? {});
  if (payloadKeys.length === 0) {
    return undefined;
  }

  return `Payload fields: ${payloadKeys.join(", ")}.`;
}

function formatFindingTypeLabel(type: CoordinationFindingType): string {
  switch (type) {
    case "architecture":
      return "Architecture";
    case "risk":
      return "Risk";
    case "decision":
      return "Decision";
    case "blocker":
      return "Blocker";
    case "dependency":
      return "Dependency";
    case "test":
      return "Test";
    case "handoff":
      return "Handoff";
    case "implementation":
      return "Implementation";
    case "command_request":
      return "Command Request";
    case "access_request":
      return "Access Request";
    case "general":
    default:
      return "General";
  }
}

const VALID_FINDING_TYPES = new Set<CoordinationFindingType>([
  "architecture",
  "risk",
  "decision",
  "blocker",
  "dependency",
  "test",
  "handoff",
  "implementation",
  "general",
  "command_request",
  "access_request",
]);

/** @internal exported for unit testing only */
export function classifyFindingType(input: {
  source: CoordinationFindingSummaryRecord["source"];
  title?: string;
  summary?: string;
  detail?: string;
  /** If metadata.findingType is a valid CoordinationFindingType, return it directly (agent self-classification). */
  transcriptMetadata?: Record<string, unknown>;
  /** 'error' or 'denied' → 'blocker' */
  toolCallStatus?: ToolCallStatus;
  /** 'DENIED' → 'blocker' */
  approvalStatus?: ApprovalStatus;
  /** 'OPEN' or 'ASSIGNED' → 'handoff' */
  handoffStatus?: HandoffStatus;
}): CoordinationFindingType {
  // Short-circuit 1: agent self-classification via transcript metadata
  const metaFindingType = input.transcriptMetadata?.findingType;
  if (typeof metaFindingType === "string" && VALID_FINDING_TYPES.has(metaFindingType as CoordinationFindingType)) {
    return metaFindingType as CoordinationFindingType;
  }

  // Short-circuit 2: structured status signals
  if (
    input.approvalStatus === "DENIED" ||
    input.toolCallStatus === "error" ||
    input.toolCallStatus === "denied"
  ) {
    return "blocker";
  }

  if (input.handoffStatus === "OPEN" || input.handoffStatus === "ASSIGNED") {
    return "handoff";
  }

  if (input.source === "handoff") {
    return "handoff";
  }

  if (input.source === "error") {
    return "blocker";
  }

  const normalized = normalizeLabel([input.title, input.summary, input.detail].filter(Boolean).join(" "));

  if (
    /\b(blocker|blocked|blocking|stuck|cannot|can t|unable|failure|failing|broken|approval|waiting|needs input|reply needed)\b/.test(
      normalized,
    )
  ) {
    return "blocker";
  }

  if (/\b(risk|warning|regression|security|performance|danger|hazard|tradeoff|watch out)\b/.test(normalized)) {
    return "risk";
  }

  if (/\b(decision|decide|decided|recommend|recommended|choose|selected|prefer|go with)\b/.test(normalized)) {
    return "decision";
  }

  if (/\b(architecture|structure|module|component|system|design|boundary|layout|topology)\b/.test(normalized)) {
    return "architecture";
  }

  if (/\b(dependency|dependencies|package|library|framework|manifest|version|sdk)\b/.test(normalized)) {
    return "dependency";
  }

  if (/\b(test|tests|testing|coverage|spec|qa|verify|verification)\b/.test(normalized)) {
    return "test";
  }

  if (/\b(implement|implementation|ship|build|refactor|patch|ui|workflow|runtime)\b/.test(normalized)) {
    return "implementation";
  }

  return "general";
}

/** @internal exported for unit testing only */
export function deriveFindingSubscriptions(
  agent: AgentSessionRecord,
  recommendation: PlannerAgentRecommendation | null,
): { types: CoordinationFindingType[]; reasons: Partial<Record<CoordinationFindingType, string>> } {
  const subscriptions = new Set<CoordinationFindingType>(["decision", "blocker", "handoff"]);
  const reasons: Partial<Record<CoordinationFindingType, string>> = {
    decision: "baseline:decision",
    blocker: "baseline:blocker",
    handoff: "baseline:handoff",
  };

  const normalized = normalizeLabel(
    [agent.title, roleFromMetadata(agent), recommendation?.role, recommendation?.objective, recommendation?.reasoning]
      .filter(Boolean)
      .join(" "),
  );

  // Role label used in reason strings for traceability
  const roleLabel = recommendation?.role ?? roleFromMetadata(agent) ?? agent.title;

  const addWithReason = (type: CoordinationFindingType, reason: string): void => {
    if (!subscriptions.has(type)) {
      subscriptions.add(type);
      reasons[type] = reason;
    }
  };

  if (/\b(architect|survey|surveyor|repository|analyst|analysis|observability|system|mapping)\b/.test(normalized)) {
    addWithReason("architecture", `role:${roleLabel}`);
    addWithReason("dependency", `role:${roleLabel}`);
    addWithReason("risk", `role:${roleLabel}`);
  }

  if (/\b(release|ops|runtime|hardening|security|platform|reliability)\b/.test(normalized)) {
    addWithReason("risk", `role:${roleLabel}`);
    addWithReason("blocker", `role:${roleLabel}`);
    addWithReason("decision", `role:${roleLabel}`);
  }

  if (/\b(implementation|engineer|workflow|ui|frontend|backend|developer|builder)\b/.test(normalized)) {
    addWithReason("implementation", `role:${roleLabel}`);
    addWithReason("architecture", `role:${roleLabel}`);
    addWithReason("dependency", `role:${roleLabel}`);
  }

  if (/\b(qa|test|testing|verification|quality)\b/.test(normalized)) {
    addWithReason("test", `role:${roleLabel}`);
    addWithReason("risk", `role:${roleLabel}`);
    addWithReason("blocker", `role:${roleLabel}`);
  }

  return { types: [...subscriptions], reasons };
}

function summarizeTeamAsk(
  workspaceId: string,
  actionRequests: CoordinationActionRequestRecord[],
  updatedAt: string,
  teamAskHistory: CoordinationTeamAskRecord[],
  currentPromptId: string | null,
): CoordinationTeamAskRecord | null {
  const needsInputRequests = actionRequests
    .filter((request) => request.kind === "needs_input")
    .sort(compareIsoDescending);

  if (needsInputRequests.length === 0) {
    return null;
  }

  const groupedByAsk = new Map<
    string,
    {
      summary: string;
      detail?: string;
      agents: string[];
    }
  >();

  for (const request of needsInputRequests) {
    const key = normalizeLabel(request.summary) || request.id;
    const existing = groupedByAsk.get(key);

    if (existing) {
      existing.agents.push(request.agentTitle);
      if (!existing.detail && request.detail) {
        existing.detail = request.detail;
      }
      continue;
    }

    groupedByAsk.set(key, {
      summary: request.summary,
      detail: request.detail,
      agents: [request.agentTitle],
    });
  }

  const groupedAsks = [...groupedByAsk.values()].map((entry) => ({
    ...entry,
    agents: uniqueStrings(entry.agents),
  }));
  const agentIds = uniqueStrings(needsInputRequests.map((request) => request.agentId));
  const requestIds = needsInputRequests.map((request) => request.id);
  const askUpdatedAt = needsInputRequests[0]?.updatedAt ?? updatedAt;

  // Derive finding types from all action requests for the implicated agents instead of hardcoding.
  const impliedAgentIds = new Set(agentIds);
  const derivedFindingTypes = new Set<CoordinationFindingType>();
  for (const request of actionRequests) {
    if (!impliedAgentIds.has(request.agentId)) continue;
    if (request.kind === "approval") {
      derivedFindingTypes.add("blocker");
    } else if (request.kind === "handoff_follow_up") {
      derivedFindingTypes.add("handoff");
    } else if (request.kind === "needs_input") {
      // Handoff-originated needs_input requests carry a handoffId
      if (request.handoffId) {
        derivedFindingTypes.add("handoff");
      } else {
        derivedFindingTypes.add("decision");
      }
    }
  }
  const findingTypes: CoordinationFindingType[] =
    derivedFindingTypes.size > 0 ? [...derivedFindingTypes] : ["decision", "blocker"];

  // Stable ID: reuse the existing ID only when BOTH the request set AND the prompt round match.
  // A new promptId means a new round — always generate a fresh ask ID even if requests look similar.
  const incomingSet = new Set(requestIds);
  const mostRecent = teamAskHistory[0];
  const existingSet = mostRecent ? new Set(mostRecent.requestIds) : new Set<string>();
  const samePromptRound = currentPromptId !== null && mostRecent?.promptId === currentPromptId;
  const setsMatch =
    samePromptRound &&
    incomingSet.size === existingSet.size &&
    [...incomingSet].every((id) => existingSet.has(id));

  const id = setsMatch && mostRecent
    ? mostRecent.id
    : `team-ask-${workspaceId}-${Date.now()}`;

  // Derive the recommended reply shape from the implicated finding types.
  let recommendedResponseShape: CoordinationTeamAskRecord["recommendedResponseShape"] = "direction";
  if (findingTypes.includes("blocker")) {
    recommendedResponseShape = "approval";
  } else if (findingTypes.includes("dependency") || findingTypes.includes("decision")) {
    recommendedResponseShape = "direction";
  } else if (findingTypes.length > 0 && findingTypes.every((t) => t === "general")) {
    recommendedResponseShape = "input";
  }

  // For multi-agent team asks, build a summary that shows what each agent actually did/needs
  // rather than a generic count. Show up to 2 agents in the headline, full list in detail.
  const multiAgentSummary = (() => {
    if (groupedAsks.length === 1) return groupedAsks[0]!.summary;
    // Use the first 2 agent asks to form the headline, trimming to reasonable length.
    const parts = groupedAsks.slice(0, 2).map((entry) => {
      const agentLabel = uniqueStrings(entry.agents).slice(0, 1)[0] ?? "Agent";
      // Truncate each agent's summary to ~100 chars so the headline stays readable.
      const agentSummary =
        entry.summary.length > 100 ? `${entry.summary.slice(0, 97)}…` : entry.summary;
      return `**${agentLabel}**: ${agentSummary}`;
    });
    const remainder = groupedAsks.length - 2;
    return parts.join("\n") + (remainder > 0 ? `\n…and ${remainder} more agent${remainder > 1 ? "s" : ""}.` : "");
  })();

  const multiAgentDetail = (() => {
    if (groupedAsks.length === 1) return groupedAsks[0]!.detail;
    return groupedAsks
      .map((entry) => `**${uniqueStrings(entry.agents).join(", ")}**: ${entry.summary}`)
      .join("\n\n");
  })();

  return {
    id,
    workspaceId,
    promptId: currentPromptId ?? undefined,
    title:
      agentIds.length === 1
        ? `${needsInputRequests[0]!.agentTitle} needs your guidance`
        : "Team needs your guidance",
    summary: multiAgentSummary,
    detail: multiAgentDetail,
    agentIds,
    requestIds,
    findingTypes,
    blockedBranches: [],
    recommendedResponseShape,
    updatedAt: askUpdatedAt,
  };
}

function summarizeFindingForBrief(finding: CoordinationFindingSummaryRecord): string {
  return `${formatFindingTypeLabel(finding.findingType)} — ${finding.agentTitle}: ${finding.summary}`.trim();
}

function summarizeActionRequestForBrief(request: CoordinationActionRequestRecord): string {
  const prefix =
    request.kind === "approval"
      ? "Approval"
      : request.kind === "handoff_follow_up"
        ? "Follow-up"
        : "Reply needed";

  return `${prefix} — ${request.agentTitle}: ${request.summary}`.trim();
}

/**
 * Batch-load the latest run context for all agents in 2 queries instead of N×6.
 * Returns a Map keyed by agentId with the same shape as the old per-agent loader.
 */
async function loadLatestRunContextBatch(
  repositories: Repositories,
  agents: AgentSessionRecord[],
): Promise<
  Map<string, { latestRun: AgentRunRecord | null; latestTranscriptEntry: TranscriptEntryRecord | null }>
> {
  const agentIds = agents.map((a) => a.id);
  const allRuns = await repositories.runs.listLatestBatchForAgents(agentIds, 6);

  // Group runs by agentId (already ordered created_at DESC within each agent)
  const runsByAgent = new Map<string, AgentRunRecord[]>();
  for (const run of allRuns) {
    const group = runsByAgent.get(run.agentId) ?? [];
    group.push(run);
    runsByAgent.set(run.agentId, group);
  }

  // Collect all runIds so we can batch-load transcripts
  const allRunIds = allRuns.map((r) => r.id);
  const allTranscript = await repositories.transcript.listLatestBatchForRuns(allRunIds, 100);

  // Group transcript entries by runId
  const transcriptByRun = new Map<string, TranscriptEntryRecord[]>();
  for (const entry of allTranscript) {
    const group = transcriptByRun.get(entry.runId) ?? [];
    group.push(entry);
    transcriptByRun.set(entry.runId, group);
  }

  // Build per-agent results matching the old loadLatestRunContext shape
  const result = new Map<
    string,
    { latestRun: AgentRunRecord | null; latestTranscriptEntry: TranscriptEntryRecord | null }
  >();

  for (const agent of agents) {
    const runs = runsByAgent.get(agent.id) ?? [];
    const latestRun = runs[0] ?? null;
    let found = false;

    for (const run of runs) {
      const transcript = transcriptByRun.get(run.id) ?? [];
      const latestTranscriptEntry =
        [...transcript]
          .reverse()
          .find((entry) => entry.entryType === "assistant" || entry.entryType === "error") ?? null;

      if (latestTranscriptEntry) {
        result.set(agent.id, { latestRun: run, latestTranscriptEntry });
        found = true;
        break;
      }
    }

    if (!found) {
      result.set(agent.id, { latestRun, latestTranscriptEntry: null });
    }
  }

  return result;
}

async function collectCoordinationSignals(
  repositories: Repositories,
  workspace: WorkspaceRecord,
  agents: AgentSessionRecord[],
  handoffSummaries: CoordinationHandoffSummaryRecord[],
  updatedAt: string,
  agentRoleMap: Map<string, string>,
): Promise<{
  findingSummaries: CoordinationFindingSummaryRecord[];
  actionRequests: CoordinationActionRequestRecord[];
  newDependencyEdges: CoordinationDependencyEdge[];
  /** Transcript content for each WAITING_INPUT agent — used for batch LLM synthesis. */
  waitingAgentInputs: WaitingAgentInput[];
}> {
  const [approvals, latestRunContextMap] = await Promise.all([
    repositories.approvals.listPending(workspace.id),
    loadLatestRunContextBatch(repositories, agents),
  ]);

  const latestRunContexts = agents.map((agent) => ({
    agent,
    ...(latestRunContextMap.get(agent.id) ?? { latestRun: null, latestTranscriptEntry: null }),
  }));

  const agentTitleById = new Map(agents.map((agent) => [agent.id, agent.title]));
  const findingSummaries: CoordinationFindingSummaryRecord[] = [];
  const actionRequests: CoordinationActionRequestRecord[] = [];
  const newDependencyEdges: CoordinationDependencyEdge[] = [];
  const waitingAgentInputs: WaitingAgentInput[] = [];

  for (const handoff of handoffSummaries) {
    if (handoff.status === "DISMISSED") {
      continue;
    }

    const sourceAgentTitle = agentTitleById.get(handoff.sourceAgentId) ?? "Agent";
    findingSummaries.push({
      id: `coord-handoff-${handoff.id}`,
      workspaceId: workspace.id,
      agentId: handoff.sourceAgentId,
      agentTitle: sourceAgentTitle,
      runId: handoff.sourceRunId,
      source: "handoff",
      findingType: "handoff",
      title: handoff.title,
      summary: summarizeText(handoff.summary, 180) || handoff.title,
      detail: truncateText(handoff.nextPrompt, 320) || undefined,
      updatedAt: handoff.updatedAt,
    });

    if (handoff.status === "OPEN" || handoff.status === "ASSIGNED") {
      const targetAgentId = handoff.assignedAgentId ?? handoff.sourceAgentId;
      const targetAgentTitle = agentTitleById.get(targetAgentId) ?? sourceAgentTitle;
      actionRequests.push({
        id: `coord-handoff-request-${handoff.id}`,
        workspaceId: workspace.id,
        agentId: targetAgentId,
        agentTitle: targetAgentTitle,
        runId: handoff.sourceRunId,
        handoffId: handoff.id,
        kind: "handoff_follow_up",
        title: handoff.title,
        summary: summarizeText(handoff.summary, 180) || handoff.title,
        detail: truncateText(handoff.nextPrompt, 320) || undefined,
        updatedAt: handoff.updatedAt,
      });
    }
  }

  for (const approval of approvals) {
    const agentTitle = agentTitleById.get(approval.agentId) ?? "Agent";
    actionRequests.push({
      id: `coord-approval-${approval.id}`,
      workspaceId: workspace.id,
      agentId: approval.agentId,
      agentTitle,
      runId: approval.runId,
      approvalId: approval.id,
      kind: "approval",
      title: `${agentTitle} needs approval`,
      summary: summarizeApprovalRequest(approval),
      detail: detailApprovalRequest(approval),
      updatedAt: approval.createdAt,
    });
  }

  for (const { agent, latestRun, latestTranscriptEntry } of latestRunContexts) {
    if (latestTranscriptEntry?.content?.trim()) {
      const source = latestTranscriptEntry.entryType === "error" ? "error" : "assistant_reply";
      findingSummaries.push({
        id: `coord-finding-${agent.id}-${latestTranscriptEntry.id}`,
        workspaceId: workspace.id,
        agentId: agent.id,
        agentTitle: agent.title,
        runId: latestRun?.id,
        source,
        findingType: classifyFindingType({
          source,
          title:
            source === "error"
              ? `${agent.title} reported an error`
              : `${agent.title} shared a finding`,
          summary: latestTranscriptEntry.content,
          transcriptMetadata: latestTranscriptEntry.metadata,
        }),
        title:
          source === "error"
            ? `${agent.title} reported an error`
            : `${agent.title} shared a finding`,
        summary: summarizeText(latestTranscriptEntry.content, 200) || `${agent.title} updated the workspace.`,
        detail:
          truncateText(latestTranscriptEntry.content, 420) !== summarizeText(latestTranscriptEntry.content, 200)
            ? truncateText(latestTranscriptEntry.content, 420)
            : undefined,
        updatedAt: latestTranscriptEntry.createdAt,
      });

      // Phase 7: command_request / access_request findings generate an approval action request and a dependency edge
      const pushedFinding = findingSummaries[findingSummaries.length - 1]!;
      if (pushedFinding.findingType === "command_request" || pushedFinding.findingType === "access_request") {
        const actionRequestId = createId("ar");
        actionRequests.push({
          id: actionRequestId,
          workspaceId: workspace.id,
          agentId: agent.id,
          agentTitle: agent.title,
          runId: latestRun?.id,
          kind: "approval",
          title: `Access request: ${pushedFinding.title || pushedFinding.summary}`,
          summary: pushedFinding.summary,
          detail: pushedFinding.detail,
          updatedAt: pushedFinding.updatedAt,
        });
        newDependencyEdges.push({
          id: createId("dep"),
          fromAgentId: agent.id,
          toAgentId: agent.id,
          dependencyType: "depends_on_approval",
          sourceId: actionRequestId,
          reason: `Agent requires approval for: ${pushedFinding.title || pushedFinding.summary}`,
          createdAt: new Date().toISOString(),
        });
      }
    } else if (latestRun?.state === "ERROR" && latestRun.errorMessage?.trim()) {
      findingSummaries.push({
        id: `coord-run-error-${agent.id}-${latestRun.id}`,
        workspaceId: workspace.id,
        agentId: agent.id,
        agentTitle: agent.title,
        runId: latestRun.id,
        source: "error",
        findingType: "blocker",
        title: `${agent.title} reported an error`,
        summary: summarizeText(latestRun.errorMessage, 200) || latestRun.errorMessage.trim(),
        detail: truncateText(latestRun.errorMessage, 420) || undefined,
        updatedAt: latestRun.completedAt ?? latestRun.updatedAt,
      });
    }

    if (agent.state === "WAITING_INPUT") {
      // Use heuristic as a fast initial summary. The batch LLM synthesis in
      // refreshWorkspaceState will overwrite this with a better message.
      const heuristicAsk =
        extractActionRequestFromText(latestTranscriptEntry?.content) ??
        extractLastStatement(latestTranscriptEntry?.content) ??
        `${agent.title} has paused and is waiting for your next instruction.`;

      actionRequests.push({
        id: `coord-needs-input-${agent.id}-${latestRun?.id ?? "pending"}`,
        workspaceId: workspace.id,
        agentId: agent.id,
        agentTitle: agent.title,
        runId: latestRun?.id,
        kind: "needs_input",
        title: `${agent.title} needs input`,
        summary: heuristicAsk,
        detail:
          latestTranscriptEntry?.content && latestTranscriptEntry.content.trim() !== heuristicAsk
            ? truncateText(latestTranscriptEntry.content, 400)
            : "The run is paused and waiting for operator guidance.",
        updatedAt: agent.lastEventAt || latestRun?.updatedAt || updatedAt,
      });

      // Record this agent's full output for batch synthesis.
      waitingAgentInputs.push({
        agentId: agent.id,
        agentTitle: agent.title,
        agentRole: agentRoleMap.get(agent.id),
        transcriptContent: latestTranscriptEntry?.content ?? "",
      });
    }
  }

  findingSummaries.sort(compareIsoDescending);
  actionRequests.sort(compareIsoDescending);

  return {
    findingSummaries,
    actionRequests,
    newDependencyEdges,
    waitingAgentInputs,
  };
}

function buildAgentBrief(
  agent: AgentSessionRecord,
  workspace: WorkspaceRecord,
  brief: CoordinationBriefRecord | null,
  handoffSummaries: CoordinationHandoffSummaryRecord[],
  findingSummaries: CoordinationFindingSummaryRecord[],
  actionRequests: CoordinationActionRequestRecord[],
  now: string,
): CoordinationAgentBriefRecord {
  const recommendation = findMatchingRecommendation(agent, brief);
  const executionOrder = findMatchingRecommendationOrder(agent, brief);
  const relatedHandoffs = handoffSummaries.filter(
    (handoff) => handoff.assignedAgentId === agent.id || handoff.sourceAgentId === agent.id,
  );
  const { types: subscribedFindingTypes, reasons: subscriptionReasons } = deriveFindingSubscriptions(agent, recommendation);
  const sharedFindings = findingSummaries
    .filter(
      (finding) =>
        finding.agentId !== agent.id &&
        subscribedFindingTypes.includes(finding.findingType),
    )
    .sort(compareIsoDescending)
    .slice(0, 4)
    .map(summarizeFindingForBrief);
  const ownActionRequests = actionRequests
    .filter((request) => request.agentId === agent.id)
    .sort(compareIsoDescending)
    .slice(0, 3)
    .map(summarizeActionRequestForBrief);
  const teamActionRequests = actionRequests
    .filter((request) => request.agentId !== agent.id)
    .sort(compareIsoDescending)
    .slice(0, 2)
    .map(summarizeActionRequestForBrief);
  const pendingActionRequests = uniqueStrings([...ownActionRequests, ...teamActionRequests]);
  const summary =
    recommendation?.objective ||
    brief?.summary ||
    `${agent.title} is operating within the shared workspace coordination state.`;
  const instructions = uniqueStrings([
    recommendation?.objective ?? "",
    recommendation?.reasoning ?? "",
    ...brief?.coordinationNotes ?? [],
    ...relatedHandoffs.map(
      (handoff) => `${handoff.status}: ${handoff.title} — ${handoff.summary}`.trim(),
    ),
  ]);

  return {
    workspaceId: workspace.id,
    agentId: agent.id,
    title: agent.title,
    role: roleFromMetadata(agent),
    executionOrder,
    provider: agent.provider,
    model: agent.model,
    executionRoot: executionRootForAgent(agent, workspace),
    matchedRecommendationRole: recommendation?.role,
    subscribedFindingTypes,
    subscriptionReasons,
    summary,
    objective: recommendation?.objective,
    instructions,
    coordinationNotes: brief?.coordinationNotes ?? [],
    risks: brief?.risks ?? [],
    sharedFindings,
    pendingActionRequests,
    relatedHandoffIds: relatedHandoffs.map((handoff) => handoff.id),
    updatedAt: now,
  };
}

/** @internal exported for unit testing only */
export function buildExecutionPlan(
  state: CoordinationStateRecord,
  agentBriefs: CoordinationAgentBriefRecord[],
): {
  executionPlan: CoordinationStateRecord["executionPlan"];
  blockedAgents: CoordinationStateRecord["blockedAgents"];
} {
  const now = new Date().toISOString();

  // Sort agents: by executionOrder ascending, ties broken by agentId lexicographic order;
  // agents without executionOrder go last.
  const sorted = [...agentBriefs].sort((a, b) => {
    if (a.executionOrder === undefined && b.executionOrder === undefined) {
      return a.agentId.localeCompare(b.agentId);
    }
    if (a.executionOrder === undefined) return 1;
    if (b.executionOrder === undefined) return -1;
    if (a.executionOrder !== b.executionOrder) return a.executionOrder - b.executionOrder;
    return a.agentId.localeCompare(b.agentId);
  });

  const executionPlan: CoordinationStateRecord["executionPlan"] = [];
  const blockedAgents: CoordinationStateRecord["blockedAgents"] = [];

  for (let i = 0; i < sorted.length; i++) {
    const brief = sorted[i]!;

    // Check for unresolved dependency edges pointing to this agent
    const unresolvedEdges = state.dependencyGraph.filter(
      (edge) => edge.toAgentId === brief.agentId && !edge.resolvedAt,
    );

    if (unresolvedEdges.length > 0) {
      const firstEdge = unresolvedEdges[0]!;
      executionPlan.push({ agentId: brief.agentId, decision: "wait", order: i, updatedAt: now });
      blockedAgents.push({
        agentId: brief.agentId,
        reason: firstEdge.reason ?? `Waiting on dependency from ${firstEdge.fromAgentId}`,
        dependencyId: firstEdge.id,
      });
      continue;
    }

    // Check for pending approval action requests for this agent
    const pendingApproval = state.actionRequests.find(
      (req) => req.agentId === brief.agentId && req.kind === "approval",
    );

    if (pendingApproval) {
      executionPlan.push({ agentId: brief.agentId, decision: "ask_user", order: i, updatedAt: now });
      continue;
    }

    // All clear
    executionPlan.push({ agentId: brief.agentId, decision: "run_now", order: i, updatedAt: now });
  }

  return { executionPlan, blockedAgents };
}

function buildCoordinationState(input: {
  workspace: WorkspaceRecord;
  brief: CoordinationBriefRecord | null;
  agents: AgentSessionRecord[];
  handoffs: HandoffItemRecord[];
  findingSummaries: CoordinationFindingSummaryRecord[];
  actionRequests: CoordinationActionRequestRecord[];
  newDependencyEdges?: CoordinationDependencyEdge[];
  updatedAt?: string;
  existingState?: CoordinationStateRecord | null;
  /** When provided, advances the active prompt round and scopes any new team ask to this ID. */
  currentPromptId?: string | null;
}): CoordinationStateRecord {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const handoffSummaries = input.handoffs.map(summarizeHandoff);
  const prevHistory = input.existingState?.teamAskHistory ?? [];
  // Use the caller-supplied promptId if given, otherwise carry forward the existing one
  const currentPromptId =
    input.currentPromptId !== undefined
      ? input.currentPromptId
      : (input.existingState?.currentPromptId ?? null);
  const teamAsk = summarizeTeamAsk(input.workspace.id, input.actionRequests, updatedAt, prevHistory, currentPromptId);

  // Build updated team ask history: prepend if it's a new distinct ask
  let teamAskHistory: CoordinationTeamAskRecord[];
  if (!teamAsk) {
    teamAskHistory = prevHistory;
  } else if (prevHistory[0]?.id === teamAsk.id) {
    // Same ask set — update updatedAt on the head entry only
    teamAskHistory = [teamAsk, ...prevHistory.slice(1)].slice(0, 20);
  } else {
    teamAskHistory = [teamAsk, ...prevHistory].slice(0, 20);
  }

  return {
    workspaceId: input.workspace.id,
    brief: input.brief,
    handoffSummaries,
    findingSummaries: input.findingSummaries,
    actionRequests: input.actionRequests,
    teamAsk,
    agentBriefs: input.agents.map((agent) =>
      buildAgentBrief(
        agent,
        input.workspace,
        input.brief,
        handoffSummaries,
        input.findingSummaries,
        input.actionRequests,
        updatedAt,
      ),
    ),
    updatedAt,
    dependencyGraph: [
      ...(input.existingState?.dependencyGraph ?? []),
      ...(input.newDependencyEdges ?? []),
    ],
    executionPlan: input.existingState?.executionPlan ?? [],
    blockedAgents: input.existingState?.blockedAgents ?? [],
    coordinatorDecisions: input.existingState?.coordinatorDecisions ?? [],
    replyPackets: input.existingState?.replyPackets ?? [],
    teamAskHistory,
    currentPromptId,
  };
}

function renderWorkspaceCoordinationContext(
  state: CoordinationStateRecord | null | undefined,
): string | undefined {
  if (!state) {
    return undefined;
  }

  const lines: string[] = ["Workspace coordination brief"];

  if (state.brief?.summary?.trim()) {
    lines.push(`Summary: ${state.brief.summary}`);
  }

  if (state.brief?.task?.trim()) {
    lines.push(`Objective: ${state.brief.task.trim()}`);
  }

  if (state.brief?.constraints?.trim()) {
    lines.push(`Constraints: ${state.brief.constraints.trim()}`);
  }

  if ((state.brief?.coordinationNotes.length ?? 0) > 0) {
    lines.push("Coordination order:");
    lines.push(...state.brief!.coordinationNotes.map((note) => `- ${note}`));
  }

  if ((state.brief?.risks.length ?? 0) > 0) {
    lines.push("Risks:");
    lines.push(...state.brief!.risks.map((risk) => `- ${risk}`));
  }

  if (state.findingSummaries.length > 0) {
    lines.push("Shared findings:");
    lines.push(...state.findingSummaries.slice(0, 5).map((finding) => `- ${summarizeFindingForBrief(finding)}`));
  }

  if (state.teamAsk) {
    lines.push(`Team ask: ${state.teamAsk.summary}`);
    if (state.teamAsk.detail?.trim()) {
      lines.push(state.teamAsk.detail.trim());
    }
  }

  const nonNeedsInputRequests = state.actionRequests.filter((request) => request.kind !== "needs_input");
  if (nonNeedsInputRequests.length > 0) {
    lines.push("Open coordination requests:");
    lines.push(...nonNeedsInputRequests.slice(0, 5).map((request) => `- ${summarizeActionRequestForBrief(request)}`));
  }

  return lines.length > 1 ? lines.join("\n") : undefined;
}

function renderAgentCoordinationContext(
  state: CoordinationStateRecord | null | undefined,
  agentId: string,
): string | undefined {
  const brief = state?.agentBriefs.find((entry) => entry.agentId === agentId);

  if (!brief) {
    return undefined;
  }

  const lines: string[] = [
    `Agent brief for ${brief.title}`,
    `Summary: ${brief.summary}`,
  ];

  if (brief.objective?.trim()) {
    lines.push(`Objective: ${brief.objective.trim()}`);
  }

  if (brief.executionRoot.trim()) {
    lines.push(`Execution root: ${brief.executionRoot.trim()}`);
  }

  if (typeof brief.executionOrder === "number") {
    lines.push(`Execution order: ${brief.executionOrder + 1}`);
  }

  if (brief.subscribedFindingTypes.length > 0) {
    lines.push(`Subscribed findings: ${brief.subscribedFindingTypes.map(formatFindingTypeLabel).join(", ")}`);
  }

  if (brief.instructions.length > 0) {
    lines.push("Instructions:");
    lines.push(...brief.instructions.map((instruction) => `- ${instruction}`));
  }

  if (brief.sharedFindings.length > 0) {
    lines.push("Peer findings:");
    lines.push(...brief.sharedFindings.map((finding) => `- ${finding}`));
  }

  if (brief.pendingActionRequests.length > 0) {
    lines.push("Open coordination requests:");
    lines.push(...brief.pendingActionRequests.map((request) => `- ${request}`));
  }

  if (brief.risks.length > 0) {
    lines.push("Watch-outs:");
    lines.push(...brief.risks.map((risk) => `- ${risk}`));
  }

  return lines.join("\n");
}

function renderRoleCoordinationContext(
  state: CoordinationStateRecord | null | undefined,
  roleOrTitle: string,
): string | undefined {
  const roleLabel = roleOrTitle.trim();

  if (!state?.brief || roleLabel.length === 0) {
    return undefined;
  }

  const recommendation = findRecommendationByLabel(state.brief, roleLabel);

  if (!recommendation) {
    return undefined;
  }

  const lines: string[] = [
    `Agent brief for ${recommendation.role}`,
    `Summary: ${recommendation.objective}`,
    `Provider/model: ${recommendation.provider}/${recommendation.model}`,
    "Instructions:",
    `- ${recommendation.objective}`,
    `- ${recommendation.reasoning}`,
  ];

  if (state.brief.coordinationNotes.length > 0) {
    lines.push("Coordination notes:");
    lines.push(...state.brief.coordinationNotes.map((note) => `- ${note}`));
  }

  if (state.brief.risks.length > 0) {
    lines.push("Watch-outs:");
    lines.push(...state.brief.risks.map((risk) => `- ${risk}`));
  }

  if (state.findingSummaries.length > 0) {
    lines.push("Shared findings:");
    lines.push(...state.findingSummaries.slice(0, 4).map((finding) => `- ${summarizeFindingForBrief(finding)}`));
  }

  if (state.teamAsk) {
    lines.push(`Team ask: ${state.teamAsk.summary}`);
  }

  const nonNeedsInputRequests = state.actionRequests.filter((request) => request.kind !== "needs_input");
  if (nonNeedsInputRequests.length > 0) {
    lines.push("Open coordination requests:");
    lines.push(...nonNeedsInputRequests.slice(0, 4).map((request) => `- ${summarizeActionRequestForBrief(request)}`));
  }

  return lines.join("\n");
}

/**
 * Internal control-plane coordinator. Not a user-visible agent.
 * All cross-agent coordination state reads and writes must go through this interface.
 * External callers must never import coordination-state pure functions directly.
 */
export interface CoordinationService {
  getWorkspaceState(workspaceId: string): Promise<CoordinationStateRecord | null>;
  refreshWorkspaceState(
    workspaceId: string,
    options?: {
      brief?: CoordinationBriefRecord | null;
      currentPromptId?: string | null;
    },
  ): Promise<CoordinationStateRecord | null>;
  renderExecutionPacket(
    workspaceId: string,
    options?: {
      agentId?: string;
      role?: string;
      title?: string;
    },
  ): Promise<RenderedCoordinationPacketRecord | null>;
  renderTeamAsk(workspaceId: string): Promise<CoordinationTeamAskRecord | null>;
  getExecutionPlan(workspaceId: string): Promise<Array<{ agentId: string; decision: CoordinatorDecisionType; order: number; updatedAt: string }> | null>;
  checkCanRun(workspaceId: string, agentId: string): Promise<{
    allowed: boolean;
    reason?: string;
    dependencyId?: string;
  }>;
  /** Compares blocked agents before/after a state refresh. Returns agentIds that are now unblocked. */
  resumeBlockedAgents(workspaceId: string): Promise<string[]>;
  setAutoSpawnCallback(cb: ((handoffId: string, prompt: string) => Promise<void>) | null): void;
  onHandoffCreated(workspaceId: string, handoffId: string): Promise<void>;
  onHandoffResolved(workspaceId: string, handoffId: string): Promise<void>;
  onRunCompleted(workspaceId: string, agentId: string, runId: string, outcome: "completed" | "error"): Promise<void>;
  onBlockerDetected(workspaceId: string, agentId: string, description: string, toolName?: string): Promise<void>;
  decomposeWorkspaceReply(workspaceId: string, input: {
    replyText: string;
    promptId: string;
    teamAskId?: string;
  }): Promise<{
    status: "routed" | "no_agents" | "all_blocked" | "stale_state";
    packets: Array<{
      agentId: string;
      content: string;
      intent: string;
      promptId: string;
    }>;
    blockedAgentIds: string[];
    reason?: string;
  }>;
}

export function createCoordinationService(repositories: Repositories): CoordinationService {
  const refreshWindowMs = 3_000;

  let autoSpawnCallback: ((handoffId: string, prompt: string) => Promise<void>) | null = null;

  return {
    async getWorkspaceState(workspaceId) {
      const existing = await repositories.coordination.findByWorkspaceId(workspaceId);

      if (existing) {
        const existingUpdatedAtMs = Date.parse(existing.updatedAt);
        if (Number.isFinite(existingUpdatedAtMs) && Date.now() - existingUpdatedAtMs < refreshWindowMs) {
          return existing;
        }
      }

      if (existing?.brief !== undefined) {
        const refreshed = await this.refreshWorkspaceState(workspaceId);
        if (refreshed) {
          return refreshed;
        }
        return existing;
      }

      return this.refreshWorkspaceState(workspaceId);
    },

    async refreshWorkspaceState(workspaceId, options) {
      const workspace = await repositories.workspaces.findById(workspaceId);

      if (!workspace) {
        return null;
      }

      const existingState = await repositories.coordination.findByWorkspaceId(workspaceId);

      const brief =
        options?.brief !== undefined
          ? options.brief
          : existingState?.brief ?? workspace.coordinationBrief ?? null;

      const [agents, handoffs] = await Promise.all([
        repositories.agents.list(workspaceId),
        repositories.handoffs.listByWorkspace(workspaceId),
      ]);
      const handoffSummaries = handoffs.map(summarizeHandoff);

      // Build a role map from the brief recommendations so the synthesizer can provide context.
      const agentRoleMap = new Map<string, string>();
      if (brief) {
        for (const agent of agents) {
          const rec = brief.agents.find(
            (r) =>
              r.role.toLowerCase() === agent.title.toLowerCase() ||
              agent.title.toLowerCase().includes(r.role.toLowerCase().split(" ")[0] ?? ""),
          );
          if (rec?.role) {
            agentRoleMap.set(agent.id, rec.role);
          }
        }
      }

      const { findingSummaries, actionRequests, newDependencyEdges, waitingAgentInputs } =
        await collectCoordinationSignals(
          repositories,
          workspace,
          agents,
          handoffSummaries,
          new Date().toISOString(),
          agentRoleMap,
        );

      // Batch LLM synthesis: send ALL waiting agent outputs in one call.
      // The model reads them together and produces a coherent team summary + per-agent asks.
      let synthesizedTeamSummary: string | null = null;
      if (waitingAgentInputs.length > 0) {
        const synthesis = await synthesizeTeamStatus(
          waitingAgentInputs,
          brief?.task,
        );

        if (synthesis) {
          // Overwrite heuristic per-agent summaries with LLM-produced ones.
          for (const request of actionRequests) {
            if (request.kind !== "needs_input") continue;
            const synthesized = synthesis.agentSummaries[request.agentTitle];
            if (synthesized) {
              request.summary = synthesized;
            }
          }
          synthesizedTeamSummary = synthesis.teamSummary;
        }
      }

      const built = buildCoordinationState({
        workspace,
        brief,
        agents,
        handoffs,
        findingSummaries,
        actionRequests,
        newDependencyEdges,
        existingState,
        currentPromptId: options?.currentPromptId !== undefined ? options.currentPromptId : undefined,
      });

      // Phase 3: recompute execution plan and blocked agents on every refresh
      const { executionPlan, blockedAgents } = buildExecutionPlan(built, built.agentBriefs);

      // Phase 4: enrich teamAsk with fresh blockedBranches now that we have the execution plan
      let teamAsk = built.teamAsk;
      if (teamAsk && blockedAgents.length > 0) {
        const agentTitleById = new Map(built.agentBriefs.map((b) => [b.agentId, b.title]));
        teamAsk = {
          ...teamAsk,
          blockedBranches: blockedAgents.map((blocked) => ({
            agentId: blocked.agentId,
            agentTitle: agentTitleById.get(blocked.agentId) ?? blocked.agentId,
            blockedSince: built.updatedAt,
            blockedReason: blocked.reason,
          })),
        };
      }

      // Apply the batch-synthesized team summary if available.
      // This replaces the heuristic/count-based summary with the LLM's concise,
      // specific description of what all agents collectively need from the operator.
      if (teamAsk && synthesizedTeamSummary) {
        teamAsk = { ...teamAsk, summary: synthesizedTeamSummary, synthesized: true };
      }

      // Keep teamAskHistory head in sync with the enriched teamAsk
      const teamAskHistory =
        teamAsk && built.teamAskHistory[0]?.id === teamAsk.id
          ? [teamAsk, ...built.teamAskHistory.slice(1)].slice(0, 20)
          : built.teamAskHistory;

      const state = { ...built, executionPlan, blockedAgents, teamAsk, teamAskHistory };

      return repositories.coordination.upsert(state);
    },

    async renderExecutionPacket(workspaceId, options) {
      const state = await this.getWorkspaceState(workspaceId);

      if (!state) {
        return null;
      }

      const workspaceContext = renderWorkspaceCoordinationContext(state)?.trim() || undefined;
      const targetContext =
        (options?.agentId
          ? renderAgentCoordinationContext(state, options.agentId)
          : options?.role || options?.title
            ? renderRoleCoordinationContext(state, options.role ?? options.title ?? "")
            : undefined)?.trim() || undefined;
      const content = [workspaceContext, targetContext].filter(Boolean).join("\n\n").trim();

      if (!content) {
        return null;
      }

      const targetAgent =
        options?.agentId !== undefined
          ? state.agentBriefs.find((briefEntry) => briefEntry.agentId === options.agentId)
          : undefined;
      const targetTitle = targetAgent?.title ?? options?.title ?? options?.role;

      return {
        workspaceId,
        agentId: options?.agentId,
        role: options?.role,
        title: targetTitle,
        workspaceContext,
        targetContext,
        content,
        updatedAt: state.updatedAt,
      };
    },

    async renderTeamAsk(workspaceId) {
      const state = await this.getWorkspaceState(workspaceId);
      return state?.teamAsk ?? null;
    },

    async getExecutionPlan(workspaceId) {
      const state = await this.getWorkspaceState(workspaceId);
      return state?.executionPlan ?? null;
    },

    async checkCanRun(workspaceId, agentId) {
      const state = await this.getWorkspaceState(workspaceId);
      if (!state) return { allowed: true };

      const planEntry = state.executionPlan.find((e) => e.agentId === agentId);
      if (!planEntry) return { allowed: true }; // not in plan → default open

      if (planEntry.decision === "wait" || planEntry.decision === "blocked") {
        const blockedEntry = state.blockedAgents.find((b) => b.agentId === agentId);
        return {
          allowed: false,
          reason: blockedEntry?.reason,
          dependencyId: blockedEntry?.dependencyId,
        };
      }

      return { allowed: true };
    },

    async resumeBlockedAgents(workspaceId) {
      const stateBefore = await this.getWorkspaceState(workspaceId);
      if (!stateBefore || stateBefore.blockedAgents.length === 0) return [];

      const blockedBefore = new Set(stateBefore.blockedAgents.map((a) => a.agentId));

      // Force a fresh rebuild so the execution plan reflects any resolved dependencies
      const stateAfter = await this.refreshWorkspaceState(workspaceId);
      if (!stateAfter) return [];

      const blockedAfter = new Set(stateAfter.blockedAgents.map((a) => a.agentId));

      return [...blockedBefore].filter((agentId) => !blockedAfter.has(agentId));
    },

    async onHandoffCreated(workspaceId, handoffId) {
      const state = await repositories.coordination.findByWorkspaceId(workspaceId);
      if (!state) {
        await this.refreshWorkspaceState(workspaceId);
        return;
      }
      const edge: CoordinationDependencyEdge = {
        id: createId("dep"),
        fromAgentId: "",
        toAgentId: handoffId,
        dependencyType: "depends_on_handoff",
        sourceId: handoffId,
        reason: `Waiting on handoff ${handoffId}`,
        createdAt: new Date().toISOString(),
      };
      const updatedState = {
        ...state,
        dependencyGraph: [...state.dependencyGraph, edge],
      };
      await repositories.coordination.upsert(updatedState);
      await this.refreshWorkspaceState(workspaceId);
      if (autoSpawnCallback) {
        const handoff = await repositories.handoffs.findById(handoffId);
        if (handoff?.autoAssign) {
          try {
            await autoSpawnCallback(handoffId, handoff.nextPrompt);
          } catch (err) {
            console.warn(`auto-spawn failed for handoff ${handoffId}: ${String(err)}`);
          }
        }
      }
    },

    async onHandoffResolved(workspaceId, handoffId) {
      const state = await repositories.coordination.findByWorkspaceId(workspaceId);
      if (!state) {
        await this.refreshWorkspaceState(workspaceId);
        return;
      }
      const resolvedAt = new Date().toISOString();
      const updatedGraph = state.dependencyGraph.map((edge) =>
        edge.sourceId === handoffId && !edge.resolvedAt
          ? { ...edge, resolvedAt }
          : edge,
      );
      const updatedState = { ...state, dependencyGraph: updatedGraph };
      await repositories.coordination.upsert(updatedState);
      await this.refreshWorkspaceState(workspaceId);
      const unblockedIds = await this.resumeBlockedAgents(workspaceId);
      if (unblockedIds.length > 0) {
        // Log unblocked agent IDs — callers can subscribe via resumeUnblockedAgents in run-orchestrator
      }
    },

    async onRunCompleted(workspaceId, agentId, _runId, outcome) {
      if (outcome !== "completed") {
        await this.refreshWorkspaceState(workspaceId);
        return;
      }
      const state = await repositories.coordination.findByWorkspaceId(workspaceId);
      if (!state) {
        await this.refreshWorkspaceState(workspaceId);
        return;
      }
      const resolvedAt = new Date().toISOString();
      const updatedGraph = state.dependencyGraph.map((edge) =>
        edge.dependencyType === "depends_on_agent" && edge.fromAgentId === agentId && !edge.resolvedAt
          ? { ...edge, resolvedAt }
          : edge,
      );
      const updatedState = { ...state, dependencyGraph: updatedGraph };
      await repositories.coordination.upsert(updatedState);
      await this.refreshWorkspaceState(workspaceId);
    },

    async onBlockerDetected(workspaceId, agentId, description, toolName) {
      // The signal collection pipeline will surface this on the next refresh.
      // Just trigger a state refresh so the finding appears in the next team ask synthesis.
      await this.refreshWorkspaceState(workspaceId);
    },

    async decomposeWorkspaceReply(workspaceId, input) {
      // Step 1: Fetch current state; if none, return stale_state
      const existingState = await repositories.coordination.findByWorkspaceId(workspaceId);
      if (!existingState) {
        return { status: "stale_state", packets: [], blockedAgentIds: [] };
      }

      // Step 2: Refresh state, advancing the prompt round to the new promptId
      const state = await this.refreshWorkspaceState(workspaceId, {
        currentPromptId: input.promptId,
      });
      if (!state) {
        return { status: "stale_state", packets: [], blockedAgentIds: [] };
      }

      // Step 3: Collect eligible agents from execution plan
      const eligibleEntries = state.executionPlan.filter(
        (entry) => entry.decision === "run_now" || entry.decision === "resume",
      );

      // Fall back to all non-stopped agents if plan is empty
      let eligibleAgentIds: string[];
      if (state.executionPlan.length === 0) {
        const agents = await repositories.agents.list(workspaceId);
        eligibleAgentIds = agents
          .filter((agent) => agent.state !== "STOPPED" && agent.state !== "COMPLETED" && agent.state !== "ERROR")
          .map((agent) => agent.id);
      } else {
        eligibleAgentIds = eligibleEntries.map((entry) => entry.agentId);
      }

      // Step 4: Handle no-eligible cases
      if (eligibleAgentIds.length === 0) {
        const hasBlocked = state.executionPlan.some(
          (entry) => entry.decision === "blocked" || entry.decision === "wait",
        );
        const blockedAgentIds = state.blockedAgents.map((b) => b.agentId);
        if (hasBlocked) {
          return { status: "all_blocked", packets: [], blockedAgentIds, reason: "All eligible agents are blocked or waiting on dependencies." };
        }
        return { status: "no_agents", packets: [], blockedAgentIds: [], reason: "No agents are available to receive this reply." };
      }

      const blockedAgentIds = state.blockedAgents.map((b) => b.agentId);

      // Step 5: Build packets for each eligible agent
      const packets: Array<{ agentId: string; content: string; intent: string; promptId: string }> = [];

      for (const agentId of eligibleAgentIds) {
        const agentBrief = state.agentBriefs.find((b) => b.agentId === agentId);
        const planEntry = state.executionPlan.find((e) => e.agentId === agentId);

        const parts: string[] = [input.replyText];

        // Append sharedFindings from the agent brief
        if (agentBrief && agentBrief.sharedFindings.length > 0) {
          parts.push(`Shared findings:\n${agentBrief.sharedFindings.map((f) => `- ${f}`).join("\n")}`);
        }

        // Append pending handoff summaries for that agent
        const agentHandoffs = state.handoffSummaries.filter(
          (h) => (h.assignedAgentId === agentId || h.sourceAgentId === agentId) &&
            (h.status === "OPEN" || h.status === "ASSIGNED"),
        );
        if (agentHandoffs.length > 0) {
          parts.push(`Pending handoffs:\n${agentHandoffs.map((h) => `- ${h.title}: ${h.summary}`).join("\n")}`);
        }

        // Append open needs_input action requests for that agent
        const openRequests = state.actionRequests.filter(
          (req) => req.agentId === agentId && req.kind === "needs_input",
        );
        if (openRequests.length > 0) {
          parts.push(`Open requests:\n${openRequests.map((req) => `- ${req.title}: ${req.summary}`).join("\n")}`);
        }

        const intent = planEntry?.decision === "resume" ? "unblock" : "continue";
        const content = parts.filter(Boolean).join("\n\n");

        packets.push({ agentId, content, intent, promptId: input.promptId });
      }

      // Step 6: Persist packets to state.replyPackets (prepend, cap at 10)
      const now = new Date().toISOString();
      const newReplyPackets: CoordinationStateRecord["replyPackets"] = [
        ...packets.map((packet) => ({
          packetId: createId("pkt"),
          workspaceId,
          agentId: packet.agentId,
          promptId: packet.promptId,
          content: packet.content,
          renderedAt: now,
        })),
        ...state.replyPackets,
      ].slice(0, 10);

      await repositories.coordination.upsert({ ...state, replyPackets: newReplyPackets });

      return { status: "routed", packets, blockedAgentIds };
    },

    setAutoSpawnCallback(cb: ((handoffId: string, prompt: string) => Promise<void>) | null): void {
      autoSpawnCallback = cb;
    },
  };
}
