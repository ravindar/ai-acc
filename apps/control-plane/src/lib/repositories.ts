import type {
  AgentMemoryBlockRecord,
  AgentMessageRecord,
  ApprovalRequestRecord,
  ApprovalStatus,
  ArtifactRecord,
  CoordinationActionRequestRecord,
  CoordinationAgentBriefRecord,
  CoordinationFindingType,
  CoordinationHandoffSummaryRecord,
  CoordinationTeamAskRecord,
  CoordinationFindingSummaryRecord,
  CoordinationStateRecord,
  CoordinationDependencyEdge,
  CoordinatorDecisionRecord,
  CoordinatorDecisionType,
  CoordinationReplyPacketRecord,
  AgentRunRecord,
  AgentRunState,
  AgentSessionRecord,
  AgentState,
  ContextItemRecord,
  ContextPackRecord,
  HandoffItemRecord,
  HandoffStatus,
  MemoryScope,
  ToolCallRecord,
  ToolCallStatus,
  TranscriptEntryRecord,
  TranscriptEntryType,
  CoordinationBriefRecord,
  UsageRollup,
  WorktreeRecord,
  WorktreeStatus,
  WorkspaceRecord,
} from "@acc/shared-types";

import type { Database, QueryParam, QueryResultRow } from "./database.js";

type TimestampValue = Date | string | null | undefined;

type WorkspaceRow = QueryResultRow & {
  id: string;
  name: string;
  description: string | null;
  project_root: string | null;
  shared_context: string | null;
  shared_context_kv: string | null;
  layout_config: string | null;
  coordination_brief: string | null;
  created_at: string;
  updated_at: string;
};

type AgentRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  provider: string;
  model: string;
  title: string | null;
  state: AgentState;
  last_event_at: string | null;
  heartbeat_at: string | null;
  metadata: string | null;
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  wt_id: string | null;
  wt_repo_root: string | null;
  wt_branch: string | null;
  wt_path: string | null;
  wt_base_ref: string | null;
  wt_status: WorktreeStatus | null;
  wt_last_validated_at: string | null;
  wt_created_at: string | null;
  wt_updated_at: string | null;
};

type WorktreeRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  agent_id: string;
  repo_root: string;
  branch: string;
  path: string;
  base_ref: string;
  status: WorktreeStatus;
  last_validated_at: string;
  created_at: string;
  updated_at: string;
};

type ContextPackRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  version: number;
  immutable: number | boolean;
  created_at: string;
};

type ContextItemRow = QueryResultRow & {
  id: string;
  context_pack_id: string;
  item_type: ContextItemRecord["type"];
  value: string;
  checksum: string;
  token_estimate: number | null;
  created_at: string;
};

type UsageRollupRow = QueryResultRow & {
  total_agents: number | null;
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
};

type ArtifactRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  agent_id: string;
  run_id: string | null;
  kind: ArtifactRecord["kind"];
  uri: string;
  size_bytes: number | null;
  created_at: string;
};

type AgentRunRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  agent_id: string;
  title: string;
  prompt: string;
  state: AgentRunState;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string;
  completed_at: string | null;
};

type TranscriptEntryRow = QueryResultRow & {
  id: string;
  run_id: string;
  workspace_id: string;
  agent_id: string;
  seq: number;
  entry_type: TranscriptEntryType;
  content: string;
  metadata: string | null;
  created_at: string;
};

type ToolCallRow = QueryResultRow & {
  id: string;
  run_id: string;
  workspace_id: string;
  agent_id: string;
  provider_call_id: string | null;
  approval_id: string | null;
  tool_name: string;
  status: ToolCallStatus;
  input: string;
  output: string | null;
  requested_cwd: string | null;
  created_at: string;
  updated_at: string;
};

type ApprovalRow = QueryResultRow & {
  id: string;
  run_id: string;
  workspace_id: string;
  agent_id: string;
  tool_call_id: string;
  status: ApprovalStatus;
  requested_action: string;
  requested_payload: string;
  reason: string | null;
  decision_message: string | null;
  created_at: string;
  decided_at: string | null;
};

type HandoffRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  source_agent_id: string;
  source_run_id: string;
  assigned_agent_id: string | null;
  title: string;
  summary: string;
  recommended_provider: "codex" | "claude";
  recommended_model: string;
  next_prompt: string;
  artifact_ids: string | null;
  auto_assign: number | null;
  status: HandoffStatus;
  created_at: string;
  updated_at: string;
};

type MemoryBlockRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  agent_id: string;
  key: string;
  value: string;
  scope: MemoryScope;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type AgentMessageRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  from_agent_id: string;
  to_agent_id: string;
  subject: string;
  content: string;
  read_at: string | null;
  created_at: string;
};

type CoordinationStateRow = QueryResultRow & {
  workspace_id: string;
  brief: string | null;
  agent_briefs: string | null;
  handoff_summaries: string | null;
  finding_summaries: string | null;
  action_requests: string | null;
  team_ask: string | null;
  created_at: string;
  updated_at: string;
  dependency_graph: string | null;
  execution_plan: string | null;
  blocked_agents: string | null;
  coordinator_decisions: string | null;
  reply_packets: string | null;
  team_ask_history: string | null;
  current_prompt_id: string | null;
  coordinator_usage: string | null;
};

function toIsoString(value: TimestampValue): string {
  if (!value) {
    return new Date(0).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  return 0;
}

function toBoolean(value: number | boolean | null | undefined): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return value === 1;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseCoordinationBrief(value: unknown): CoordinationBriefRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const coordinationNotes = Array.isArray(record.coordinationNotes)
    ? record.coordinationNotes.filter((item): item is string => typeof item === "string")
    : [];
  const risks = Array.isArray(record.risks)
    ? record.risks.filter((item): item is string => typeof item === "string")
    : [];
  const agents = Array.isArray(record.agents)
    ? record.agents.filter(
        (item): item is CoordinationBriefRecord["agents"][number] =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).role === "string" &&
          typeof (item as Record<string, unknown>).objective === "string" &&
          ((item as Record<string, unknown>).provider === "codex" ||
            (item as Record<string, unknown>).provider === "claude") &&
          typeof (item as Record<string, unknown>).model === "string" &&
          typeof (item as Record<string, unknown>).reasoning === "string",
      )
    : [];

  if (typeof record.savedAt !== "string" || typeof record.summary !== "string") {
    return null;
  }

  const source =
    record.source === "planner" || record.source === "saved_recommendation" || record.source === "manual"
      ? record.source
      : "manual";

  return {
    savedAt: record.savedAt,
    source,
    task: typeof record.task === "string" ? record.task : undefined,
    constraints: typeof record.constraints === "string" ? record.constraints : undefined,
    advisorProvider:
      record.advisorProvider === "codex" || record.advisorProvider === "claude"
        ? record.advisorProvider
        : undefined,
    advisorModel: typeof record.advisorModel === "string" ? record.advisorModel : undefined,
    summary: record.summary,
    coordinationNotes,
    risks,
    agents,
  };
}

function parseCoordinationHandoffSummaries(value: string | null | undefined): CoordinationHandoffSummaryRecord[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is CoordinationHandoffSummaryRecord => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return false;
      }

      const record = item as Record<string, unknown>;
      return (
        typeof record.id === "string" &&
        typeof record.sourceAgentId === "string" &&
        typeof record.sourceRunId === "string" &&
        typeof record.title === "string" &&
        typeof record.summary === "string" &&
        typeof record.nextPrompt === "string" &&
        (record.recommendedProvider === "codex" || record.recommendedProvider === "claude") &&
        typeof record.recommendedModel === "string" &&
        Array.isArray(record.artifactIds) &&
        typeof record.updatedAt === "string"
      );
    });
  } catch {
    return [];
  }
}

function parseCoordinationFindingSummaries(value: string | null | undefined): CoordinationFindingSummaryRecord[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item): CoordinationFindingSummaryRecord[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }

      const record = item as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.workspaceId !== "string" ||
        typeof record.agentId !== "string" ||
        typeof record.agentTitle !== "string" ||
        typeof record.source !== "string" ||
        typeof record.title !== "string" ||
        typeof record.summary !== "string" ||
        typeof record.updatedAt !== "string"
      ) {
        return [];
      }

      return [
        {
          id: record.id,
          workspaceId: record.workspaceId,
          agentId: record.agentId,
          agentTitle: record.agentTitle,
          runId: typeof record.runId === "string" ? record.runId : undefined,
          source: record.source as CoordinationFindingSummaryRecord["source"],
          findingType:
            typeof record.findingType === "string" &&
            VALID_FINDING_TYPES.has(record.findingType as CoordinationFindingType)
              ? (record.findingType as CoordinationFindingType)
              : "general",
          title: record.title,
          summary: record.summary,
          detail: typeof record.detail === "string" ? record.detail : undefined,
          updatedAt: record.updatedAt,
        },
      ];
    });
  } catch {
    return [];
  }
}

function parseCoordinationActionRequests(value: string | null | undefined): CoordinationActionRequestRecord[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is CoordinationActionRequestRecord => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return false;
      }

      const record = item as Record<string, unknown>;
      return (
        typeof record.id === "string" &&
        typeof record.workspaceId === "string" &&
        typeof record.agentId === "string" &&
        typeof record.agentTitle === "string" &&
        typeof record.kind === "string" &&
        typeof record.title === "string" &&
        typeof record.summary === "string" &&
        typeof record.updatedAt === "string"
      );
    });
  } catch {
    return [];
  }
}

function parseCoordinationTeamAsk(value: string | null | undefined): CoordinationTeamAskRecord | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.workspaceId !== "string" ||
      typeof record.title !== "string" ||
      typeof record.summary !== "string" ||
      !Array.isArray(record.agentIds) ||
      !Array.isArray(record.requestIds) ||
      !Array.isArray(record.findingTypes) ||
      typeof record.updatedAt !== "string"
    ) {
      return null;
    }

    const validResponseShapes = new Set(["approval", "input", "direction", "confirmation"]);

    const blockedBranches: CoordinationTeamAskRecord["blockedBranches"] = Array.isArray(record.blockedBranches)
      ? record.blockedBranches.flatMap((item): NonNullable<CoordinationTeamAskRecord["blockedBranches"]> => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const b = item as Record<string, unknown>;
          if (
            typeof b.agentId !== "string" ||
            typeof b.agentTitle !== "string" ||
            typeof b.blockedSince !== "string" ||
            typeof b.blockedReason !== "string"
          ) return [];
          return [{ agentId: b.agentId, agentTitle: b.agentTitle, blockedSince: b.blockedSince, blockedReason: b.blockedReason }];
        })
      : [];

    return {
      id: record.id,
      workspaceId: record.workspaceId,
      promptId: typeof record.promptId === "string" ? record.promptId : undefined,
      title: record.title,
      summary: record.summary,
      detail: typeof record.detail === "string" ? record.detail : undefined,
      agentIds: record.agentIds.filter((item): item is string => typeof item === "string"),
      requestIds: record.requestIds.filter((item): item is string => typeof item === "string"),
      findingTypes: record.findingTypes.filter(
        (item): item is CoordinationFindingSummaryRecord["findingType"] => typeof item === "string",
      ),
      blockedBranches,
      recommendedResponseShape:
        typeof record.recommendedResponseShape === "string" && validResponseShapes.has(record.recommendedResponseShape)
          ? (record.recommendedResponseShape as CoordinationTeamAskRecord["recommendedResponseShape"])
          : "direction",
      synthesized: record.synthesized === true,
      dismissed: record.dismissed === true,
      updatedAt: record.updatedAt,
    };
  } catch {
    return null;
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

const VALID_DEPENDENCY_TYPES = new Set<CoordinationDependencyEdge["dependencyType"]>([
  "depends_on_finding",
  "depends_on_agent",
  "depends_on_handoff",
  "depends_on_approval",
  "depends_on_user_input",
]);

const VALID_DECISION_TYPES = new Set<CoordinatorDecisionType>([
  "run_now",
  "wait",
  "resume",
  "blocked",
  "ask_user",
  "request_approval",
]);

function parseCoordinationDependencyGraph(value: string | null | undefined): CoordinationDependencyEdge[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CoordinationDependencyEdge[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const r = item as Record<string, unknown>;
      if (
        typeof r.id !== "string" ||
        typeof r.fromAgentId !== "string" ||
        typeof r.toAgentId !== "string" ||
        typeof r.dependencyType !== "string" ||
        !VALID_DEPENDENCY_TYPES.has(r.dependencyType as CoordinationDependencyEdge["dependencyType"]) ||
        typeof r.sourceId !== "string" ||
        typeof r.createdAt !== "string"
      ) return [];
      return [{
        id: r.id,
        fromAgentId: r.fromAgentId,
        toAgentId: r.toAgentId,
        dependencyType: r.dependencyType as CoordinationDependencyEdge["dependencyType"],
        sourceId: r.sourceId,
        reason: typeof r.reason === "string" ? r.reason : undefined,
        resolvedAt: typeof r.resolvedAt === "string" ? r.resolvedAt : undefined,
        createdAt: r.createdAt,
      }];
    });
  } catch { return []; }
}

function parseCoordinationExecutionPlan(value: string | null | undefined): CoordinationStateRecord["executionPlan"] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CoordinationStateRecord["executionPlan"] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const r = item as Record<string, unknown>;
      if (
        typeof r.agentId !== "string" ||
        typeof r.decision !== "string" ||
        !VALID_DECISION_TYPES.has(r.decision as CoordinatorDecisionType) ||
        typeof r.order !== "number" ||
        typeof r.updatedAt !== "string"
      ) return [];
      return [{ agentId: r.agentId, decision: r.decision as CoordinatorDecisionType, order: r.order, updatedAt: r.updatedAt }];
    });
  } catch { return []; }
}

function parseCoordinationBlockedAgents(value: string | null | undefined): CoordinationStateRecord["blockedAgents"] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CoordinationStateRecord["blockedAgents"] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const r = item as Record<string, unknown>;
      if (typeof r.agentId !== "string" || typeof r.reason !== "string" || typeof r.dependencyId !== "string") return [];
      return [{ agentId: r.agentId, reason: r.reason, dependencyId: r.dependencyId }];
    });
  } catch { return []; }
}

function parseCoordinatorDecisions(value: string | null | undefined): CoordinatorDecisionRecord[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CoordinatorDecisionRecord[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const r = item as Record<string, unknown>;
      if (
        typeof r.id !== "string" ||
        typeof r.workspaceId !== "string" ||
        typeof r.agentId !== "string" ||
        typeof r.decision !== "string" ||
        !VALID_DECISION_TYPES.has(r.decision as CoordinatorDecisionType) ||
        typeof r.reason !== "string" ||
        !Array.isArray(r.dependencyIds) ||
        typeof r.decidedAt !== "string"
      ) return [];
      return [{
        id: r.id,
        workspaceId: r.workspaceId,
        agentId: r.agentId,
        decision: r.decision as CoordinatorDecisionType,
        reason: r.reason,
        dependencyIds: r.dependencyIds.filter((d): d is string => typeof d === "string"),
        decidedAt: r.decidedAt,
      }];
    });
  } catch { return []; }
}

function parseCoordinationReplyPackets(value: string | null | undefined): CoordinationReplyPacketRecord[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CoordinationReplyPacketRecord[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const r = item as Record<string, unknown>;
      if (
        typeof r.packetId !== "string" ||
        typeof r.workspaceId !== "string" ||
        typeof r.content !== "string" ||
        typeof r.renderedAt !== "string"
      ) return [];
      return [{
        packetId: r.packetId,
        workspaceId: r.workspaceId,
        agentId: typeof r.agentId === "string" ? r.agentId : undefined,
        promptId: typeof r.promptId === "string" ? r.promptId : undefined,
        content: r.content,
        renderedAt: r.renderedAt,
      }];
    });
  } catch { return []; }
}

function parseCoordinationTeamAskHistory(value: string | null | undefined): CoordinationTeamAskRecord[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CoordinationTeamAskRecord[] => {
      const record = parseCoordinationTeamAsk(JSON.stringify(item));
      return record ? [record] : [];
    });
  } catch { return []; }
}

function parseCoordinationAgentBriefs(value: string | null | undefined): CoordinationAgentBriefRecord[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item): CoordinationAgentBriefRecord[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }

      const record = item as Record<string, unknown>;
      if (
        typeof record.workspaceId !== "string" ||
        typeof record.agentId !== "string" ||
        typeof record.title !== "string" ||
        (record.executionOrder !== undefined && typeof record.executionOrder !== "number") ||
        typeof record.provider !== "string" ||
        typeof record.model !== "string" ||
        typeof record.executionRoot !== "string" ||
        typeof record.summary !== "string" ||
        !Array.isArray(record.instructions) ||
        !Array.isArray(record.coordinationNotes) ||
        !Array.isArray(record.risks) ||
        !Array.isArray(record.sharedFindings) ||
        !Array.isArray(record.pendingActionRequests) ||
        !Array.isArray(record.relatedHandoffIds) ||
        typeof record.updatedAt !== "string"
      ) {
        return [];
      }

      return [
        {
          workspaceId: record.workspaceId,
          agentId: record.agentId,
          title: record.title,
          role: typeof record.role === "string" ? record.role : undefined,
          executionOrder: typeof record.executionOrder === "number" ? record.executionOrder : undefined,
          provider: record.provider,
          model: record.model,
          executionRoot: record.executionRoot,
          matchedRecommendationRole:
            typeof record.matchedRecommendationRole === "string" ? record.matchedRecommendationRole : undefined,
          subscribedFindingTypes: Array.isArray(record.subscribedFindingTypes)
            ? record.subscribedFindingTypes.filter(
                (item): item is CoordinationFindingType =>
                  typeof item === "string" && VALID_FINDING_TYPES.has(item as CoordinationFindingType),
              )
            : [],
          subscriptionReasons:
            record.subscriptionReasons &&
            typeof record.subscriptionReasons === "object" &&
            !Array.isArray(record.subscriptionReasons)
              ? (record.subscriptionReasons as Partial<Record<CoordinationFindingType, string>>)
              : {},
          summary: record.summary,
          objective: typeof record.objective === "string" ? record.objective : undefined,
          instructions: record.instructions.filter((item): item is string => typeof item === "string"),
          coordinationNotes: record.coordinationNotes.filter((item): item is string => typeof item === "string"),
          risks: record.risks.filter((item): item is string => typeof item === "string"),
          sharedFindings: record.sharedFindings.filter((item): item is string => typeof item === "string"),
          pendingActionRequests: record.pendingActionRequests.filter((item): item is string => typeof item === "string"),
          relatedHandoffIds: record.relatedHandoffIds.filter((item): item is string => typeof item === "string"),
          updatedAt: record.updatedAt,
        },
      ];
    });
  } catch {
    return [];
  }
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function buildInClause(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

function parseStringMap(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  const layoutConfig = parseJsonObject(row.layout_config);
  // Prefer the dedicated coordination_brief column; fall back to the layoutConfig copy for rows
  // migrated before 0009 or where the column is absent.
  const coordinationBrief =
    row.coordination_brief !== null && row.coordination_brief !== undefined
      ? parseCoordinationBrief(
          (() => { try { return JSON.parse(row.coordination_brief!); } catch { return null; } })(),
        )
      : parseCoordinationBrief(layoutConfig.coordinationBrief);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    projectRoot: row.project_root ?? "",
    sharedContext: row.shared_context ?? "",
    sharedContextKv: parseStringMap(row.shared_context_kv),
    coordinationBrief,
    layoutConfig,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapMemoryBlock(row: MemoryBlockRow): AgentMemoryBlockRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    key: row.key,
    value: row.value,
    scope: row.scope,
    expiresAt: row.expires_at ?? null,
    version: row.version ?? 1,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapAgentMessage(row: AgentMessageRow): AgentMessageRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    subject: row.subject,
    content: row.content,
    readAt: row.read_at ?? undefined,
    createdAt: toIsoString(row.created_at),
  };
}

function mapWorktree(row: WorktreeRow): WorktreeRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    repoRoot: row.repo_root,
    branch: row.branch,
    path: row.path,
    baseRef: row.base_ref,
    status: row.status,
    lastValidatedAt: toIsoString(row.last_validated_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapJoinedWorktree(row: AgentRow): WorktreeRecord | null {
  if (!row.wt_id) {
    return null;
  }

  return {
    id: row.wt_id,
    workspaceId: row.workspace_id,
    agentId: row.id,
    repoRoot: row.wt_repo_root ?? "",
    branch: row.wt_branch ?? "",
    path: row.wt_path ?? "",
    baseRef: row.wt_base_ref ?? "HEAD",
    status: (row.wt_status ?? "MISSING") as WorktreeStatus,
    lastValidatedAt: toIsoString(row.wt_last_validated_at),
    createdAt: toIsoString(row.wt_created_at),
    updatedAt: toIsoString(row.wt_updated_at),
  };
}

function mapAgent(row: AgentRow): AgentSessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    model: row.model,
    title: row.title ?? `${row.provider}:${row.model}`,
    state: row.state,
    lastEventAt: toIsoString(row.last_event_at),
    heartbeatAt: toIsoString(row.heartbeat_at),
    usage: {
      totalCostUsd: toNumber(row.total_cost_usd),
      totalInputTokens: toNumber(row.total_input_tokens),
      totalOutputTokens: toNumber(row.total_output_tokens),
    },
    metadata: parseJsonObject(row.metadata),
    worktree: mapJoinedWorktree(row),
  };
}

function mapContextItem(row: ContextItemRow): ContextItemRecord {
  return {
    id: row.id,
    type: row.item_type,
    value: row.value,
    checksum: row.checksum,
    tokenEstimate: row.token_estimate ?? 0,
  };
}

function mapContextPack(row: ContextPackRow, items: ContextItemRecord[]): ContextPackRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description ?? "",
    version: row.version,
    immutable: toBoolean(row.immutable),
    items,
    createdAt: toIsoString(row.created_at),
  };
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    runId: row.run_id ?? undefined,
    kind: row.kind,
    uri: row.uri,
    sizeBytes: row.size_bytes ?? undefined,
    createdAt: toIsoString(row.created_at),
  };
}

function mapRun(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    title: row.title,
    prompt: row.prompt,
    state: row.state,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: toIsoString(row.started_at),
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    errorMessage: row.error_message ?? undefined,
  };
}

function mapTranscriptEntry(row: TranscriptEntryRow): TranscriptEntryRecord {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    seq: row.seq,
    entryType: row.entry_type,
    content: row.content,
    metadata: parseJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at),
  };
}

function mapToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    providerCallId: row.provider_call_id ?? undefined,
    approvalId: row.approval_id ?? undefined,
    toolName: row.tool_name,
    status: row.status,
    input: parseJsonObject(row.input),
    output: row.output ? parseJsonObject(row.output) : undefined,
    requestedCwd: row.requested_cwd ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapApproval(row: ApprovalRow): ApprovalRequestRecord {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    toolCallId: row.tool_call_id,
    status: row.status,
    requestedAction: row.requested_action,
    requestedPayload: parseJsonObject(row.requested_payload),
    reason: row.reason ?? undefined,
    decisionMessage: row.decision_message ?? undefined,
    createdAt: toIsoString(row.created_at),
    decidedAt: row.decided_at ? toIsoString(row.decided_at) : undefined,
  };
}

function mapHandoff(row: HandoffRow): HandoffItemRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceAgentId: row.source_agent_id,
    sourceRunId: row.source_run_id,
    assignedAgentId: row.assigned_agent_id ?? undefined,
    title: row.title,
    summary: row.summary,
    autoAssign: row.auto_assign === 1,
    recommendedProvider: row.recommended_provider,
    recommendedModel: row.recommended_model,
    nextPrompt: row.next_prompt,
    artifactIds: parseJsonArray(row.artifact_ids),
    status: row.status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapCoordinationState(row: CoordinationStateRow): CoordinationStateRecord {
  let brief: CoordinationBriefRecord | null = null;

  if (row.brief) {
    try {
      brief = parseCoordinationBrief(JSON.parse(row.brief));
    } catch {
      brief = null;
    }
  }

  return {
    workspaceId: row.workspace_id,
    brief,
    agentBriefs: parseCoordinationAgentBriefs(row.agent_briefs),
    handoffSummaries: parseCoordinationHandoffSummaries(row.handoff_summaries),
    findingSummaries: parseCoordinationFindingSummaries(row.finding_summaries),
    actionRequests: parseCoordinationActionRequests(row.action_requests),
    teamAsk: parseCoordinationTeamAsk(row.team_ask),
    updatedAt: toIsoString(row.updated_at),
    dependencyGraph: parseCoordinationDependencyGraph(row.dependency_graph),
    executionPlan: parseCoordinationExecutionPlan(row.execution_plan),
    blockedAgents: parseCoordinationBlockedAgents(row.blocked_agents),
    coordinatorDecisions: parseCoordinatorDecisions(row.coordinator_decisions),
    replyPackets: parseCoordinationReplyPackets(row.reply_packets),
    teamAskHistory: parseCoordinationTeamAskHistory(row.team_ask_history),
    currentPromptId: row.current_prompt_id ?? null,
    coordinatorUsage: (() => {
      try { return row.coordinator_usage ? (JSON.parse(row.coordinator_usage) as CoordinationStateRecord["coordinatorUsage"]) : undefined; }
      catch { return undefined; }
    })(),
  };
}

async function listAgentRows(db: Database, workspaceId?: string, ids?: readonly string[]): Promise<AgentRow[]> {
  const params: QueryParam[] = [];
  const whereClauses: string[] = [];

  if (workspaceId) {
    whereClauses.push("agent.workspace_id = ?");
    params.push(workspaceId);
  }

  if (ids && ids.length > 0) {
    whereClauses.push(`agent.id in (${buildInClause(ids)})`);
    params.push(...ids);
  }

  const result = await db.query<AgentRow>(
    `
      select
        agent.id,
        agent.workspace_id,
        agent.provider,
        agent.model,
        agent.title,
        agent.state,
        agent.last_event_at,
        agent.heartbeat_at,
        agent.metadata,
        coalesce(usage.total_cost_usd, 0) as total_cost_usd,
        coalesce(usage.total_input_tokens, 0) as total_input_tokens,
        coalesce(usage.total_output_tokens, 0) as total_output_tokens,
        worktree.id as wt_id,
        worktree.repo_root as wt_repo_root,
        worktree.branch as wt_branch,
        worktree.path as wt_path,
        worktree.base_ref as wt_base_ref,
        worktree.status as wt_status,
        worktree.last_validated_at as wt_last_validated_at,
        worktree.created_at as wt_created_at,
        worktree.updated_at as wt_updated_at
      from agent_sessions agent
      left join (
        select
          agent_id,
          coalesce(sum(cost_usd), 0) as total_cost_usd,
          coalesce(sum(input_tokens), 0) as total_input_tokens,
          coalesce(sum(output_tokens), 0) as total_output_tokens
        from usage_ticks
        group by agent_id
      ) usage on usage.agent_id = agent.id
      left join agent_worktrees worktree on worktree.agent_id = agent.id
      ${whereClauses.length > 0 ? `where ${whereClauses.join(" and ")}` : ""}
      order by agent.created_at desc
    `,
    params,
  );

  return result.rows;
}

async function getNextTranscriptSequence(db: Database, runId: string): Promise<number> {
  const result = await db.query<QueryResultRow>(
    `select coalesce(max(seq), 0) + 1 as next_seq from transcript_entries where run_id = ?`,
    [runId],
  );
  return toNumber(result.rows[0]?.next_seq as number | string | null | undefined);
}

export interface Repositories {
  workspaces: {
    list(): Promise<WorkspaceRecord[]>;
    create(input: Pick<WorkspaceRecord, "id" | "name" | "description" | "projectRoot" | "sharedContext" | "layoutConfig">): Promise<WorkspaceRecord>;
    findById(id: string): Promise<WorkspaceRecord | null>;
    update(id: string, input: Partial<Pick<WorkspaceRecord, "name" | "description" | "projectRoot" | "sharedContext" | "sharedContextKv" | "layoutConfig">>): Promise<WorkspaceRecord | null>;
    updateSharedContextKey(workspaceId: string, key: string, value: string): Promise<WorkspaceRecord | null>;
    delete(id: string): Promise<boolean>;
  };
  agents: {
    list(workspaceId?: string): Promise<AgentSessionRecord[]>;
    findById(id: string): Promise<AgentSessionRecord | null>;
    findByIds(ids: string[]): Promise<AgentSessionRecord[]>;
    create(agent: AgentSessionRecord): Promise<AgentSessionRecord>;
    update(id: string, input: Partial<Pick<AgentSessionRecord, "title" | "metadata">>): Promise<AgentSessionRecord | null>;
  };
  worktrees: {
    findByAgentId(agentId: string): Promise<WorktreeRecord | null>;
    upsert(worktree: WorktreeRecord): Promise<WorktreeRecord>;
    deleteByAgentId(agentId: string): Promise<boolean>;
  };
  runs: {
    listByAgent(agentId: string): Promise<AgentRunRecord[]>;
    /** Returns up to `limitPerAgent` most recent runs for each agent in a single query. */
    listLatestBatchForAgents(agentIds: string[], limitPerAgent: number): Promise<AgentRunRecord[]>;
    findById(id: string): Promise<AgentRunRecord | null>;
    findActiveByAgent(agentId: string): Promise<AgentRunRecord | null>;
    /** Returns the most recent QUEUED run for the given agent, or null. */
    findQueuedForAgent(agentId: string): Promise<AgentRunRecord | null>;
    create(run: AgentRunRecord): Promise<AgentRunRecord>;
    updateState(id: string, input: { state: AgentRunState; errorMessage?: string; completedAt?: string }): Promise<AgentRunRecord | null>;
  };
  transcript: {
    listByRun(runId: string): Promise<TranscriptEntryRecord[]>;
    listByRunLimited(runId: string, lastN: number): Promise<TranscriptEntryRecord[]>;
    /** Returns up to `limitPerRun` transcript entries for each run in a single query. */
    listLatestBatchForRuns(runIds: string[], limitPerRun: number): Promise<TranscriptEntryRecord[]>;
    /** Returns entries with seq > sinceSeq, up to limit, in ascending order. */
    listByRunSince(runId: string, sinceSeq: number, limit: number): Promise<TranscriptEntryRecord[]>;
    /** Returns the highest seq number for a run (0 if none). */
    maxSeq(runId: string): Promise<number>;
    append(entry: Omit<TranscriptEntryRecord, "seq"> & { seq?: number }): Promise<TranscriptEntryRecord>;
  };
  toolCalls: {
    listByRun(runId: string): Promise<ToolCallRecord[]>;
    findById(id: string): Promise<ToolCallRecord | null>;
    create(call: ToolCallRecord): Promise<ToolCallRecord>;
    update(
      id: string,
      input: Partial<Pick<ToolCallRecord, "providerCallId" | "status" | "approvalId" | "output" | "requestedCwd">>,
    ): Promise<ToolCallRecord | null>;
  };
  approvals: {
    listPending(workspaceId?: string): Promise<ApprovalRequestRecord[]>;
    findById(id: string): Promise<ApprovalRequestRecord | null>;
    create(approval: ApprovalRequestRecord): Promise<ApprovalRequestRecord>;
    resolve(id: string, status: Exclude<ApprovalStatus, "PENDING">, decisionMessage?: string): Promise<ApprovalRequestRecord | null>;
  };
  handoffs: {
    listByWorkspace(workspaceId: string): Promise<HandoffItemRecord[]>;
    findById(id: string): Promise<HandoffItemRecord | null>;
    create(handoff: HandoffItemRecord): Promise<HandoffItemRecord>;
    assign(id: string, assignedAgentId: string): Promise<HandoffItemRecord | null>;
    updateStatus(id: string, status: HandoffStatus): Promise<HandoffItemRecord | null>;
  };
  coordination: {
    findByWorkspaceId(workspaceId: string): Promise<CoordinationStateRecord | null>;
    upsert(state: CoordinationStateRecord): Promise<CoordinationStateRecord>;
    dismissTeamAsk(workspaceId: string): Promise<void>;
  };
  contexts: {
    list(workspaceId?: string): Promise<ContextPackRecord[]>;
    findById(id: string): Promise<ContextPackRecord | null>;
    create(contextPack: ContextPackRecord): Promise<ContextPackRecord>;
    mount(contextPackId: string, agentIds: string[], maxContextTokens?: number): Promise<number>;
    listMountedItems(agentId: string): Promise<ContextItemRecord[]>;
  };
  usage: {
    getSummary(workspaceId?: string): Promise<UsageRollup>;
  };
  artifacts: {
    listByAgent(agentId: string): Promise<ArtifactRecord[]>;
    listByRun(runId: string): Promise<ArtifactRecord[]>;
    create(artifact: ArtifactRecord): Promise<ArtifactRecord>;
  };
  memory: {
    upsert(block: AgentMemoryBlockRecord): Promise<AgentMemoryBlockRecord>;
    /** List non-expired memory blocks for this agent. */
    listForAgent(agentId: string): Promise<AgentMemoryBlockRecord[]>;
    /** List non-expired workspace-scoped memory blocks. */
    listWorkspaceScoped(workspaceId: string): Promise<AgentMemoryBlockRecord[]>;
    findByAgentAndKey(agentId: string, key: string): Promise<AgentMemoryBlockRecord | null>;
    deleteByAgentAndKey(agentId: string, key: string): Promise<boolean>;
    /** Purge all expired memory blocks across all workspaces. Returns count deleted. */
    purgeExpired(): Promise<number>;
  };
  messages: {
    send(message: AgentMessageRecord): Promise<AgentMessageRecord>;
    listUnreadForAgent(agentId: string): Promise<AgentMessageRecord[]>;
    markRead(messageId: string, agentId: string): Promise<AgentMessageRecord | null>;
    findById(id: string): Promise<AgentMessageRecord | null>;
    verifySameWorkspace(fromAgentId: string, toAgentId: string): Promise<boolean>;
  };
}

export function createRepositories(db: Database): Repositories {
  return {
    workspaces: {
      async list(): Promise<WorkspaceRecord[]> {
        const result = await db.query<WorkspaceRow>(`
            select id, name, description, project_root, shared_context, shared_context_kv, layout_config, coordination_brief, created_at, updated_at
            from workspaces
            order by created_at desc
          `);
        return result.rows.map(mapWorkspace);
      },
      async create(input): Promise<WorkspaceRecord> {
        const now = new Date().toISOString();
        await db.query(
          `insert into workspaces (id, name, description, project_root, shared_context, layout_config, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.id,
            input.name,
            input.description,
            input.projectRoot,
            input.sharedContext,
            JSON.stringify(input.layoutConfig ?? {}),
            now,
            now,
          ],
        );
        const workspace = await this.findById(input.id);
        if (!workspace) throw new Error(`Failed to create workspace ${input.id}`);
        return workspace;
      },
      async findById(id): Promise<WorkspaceRecord | null> {
        const result = await db.query<WorkspaceRow>(
          `select id, name, description, project_root, shared_context, shared_context_kv, layout_config, coordination_brief, created_at, updated_at from workspaces where id = ?`,
          [id],
        );
        return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
      },
      async update(id, input): Promise<WorkspaceRecord | null> {
        const existing = await this.findById(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        const nextKv = input.sharedContextKv ?? existing.sharedContextKv;
        await db.query(
          `update workspaces set name = ?, description = ?, project_root = ?, shared_context = ?, shared_context_kv = ?, layout_config = ?, updated_at = ? where id = ?`,
          [
            input.name ?? existing.name,
            input.description ?? existing.description,
            input.projectRoot ?? existing.projectRoot,
            input.sharedContext ?? existing.sharedContext,
            JSON.stringify(nextKv),
            JSON.stringify(input.layoutConfig ?? existing.layoutConfig),
            now,
            id,
          ],
        );
        return this.findById(id);
      },
      async updateSharedContextKey(workspaceId, key, value): Promise<WorkspaceRecord | null> {
        const existing = await this.findById(workspaceId);
        if (!existing) return null;
        const kv = { ...existing.sharedContextKv, [key]: value };
        const now = new Date().toISOString();
        await db.query(
          `update workspaces set shared_context_kv = ?, updated_at = ? where id = ?`,
          [JSON.stringify(kv), now, workspaceId],
        );
        return this.findById(workspaceId);
      },
      async delete(id): Promise<boolean> {
        const result = await db.query(`delete from workspaces where id = ?`, [id]);
        return result.rowCount > 0;
      },
    },

    agents: {
      async list(workspaceId?: string): Promise<AgentSessionRecord[]> {
        return (await listAgentRows(db, workspaceId)).map(mapAgent);
      },
      async findById(id: string): Promise<AgentSessionRecord | null> {
        const rows = await listAgentRows(db, undefined, [id]);
        return rows[0] ? mapAgent(rows[0]) : null;
      },
      async findByIds(ids: string[]): Promise<AgentSessionRecord[]> {
        if (ids.length === 0) return [];
        return (await listAgentRows(db, undefined, ids)).map(mapAgent);
      },
      async create(agent): Promise<AgentSessionRecord> {
        const now = new Date().toISOString();
        await db.query(
          `insert into agent_sessions (
            id, workspace_id, provider, model, title, state, heartbeat_at, last_event_at, metadata, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            agent.id,
            agent.workspaceId,
            agent.provider,
            agent.model,
            agent.title,
            agent.state,
            agent.heartbeatAt,
            agent.lastEventAt,
            JSON.stringify(agent.metadata),
            now,
            now,
          ],
        );
        const createdAgent = await this.findById(agent.id);
        if (!createdAgent) throw new Error(`Failed to create agent ${agent.id}`);
        return createdAgent;
      },
      async update(id, input): Promise<AgentSessionRecord | null> {
        const existing = await this.findById(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        const nextMetadata = { ...existing.metadata };

        if (input.metadata) {
          for (const [key, value] of Object.entries(input.metadata)) {
            if (value === null || value === undefined) {
              delete nextMetadata[key];
            } else {
              nextMetadata[key] = value;
            }
          }
        }

        await db.query(
          `update agent_sessions set title = ?, metadata = ?, updated_at = ? where id = ?`,
          [input.title ?? existing.title, JSON.stringify(nextMetadata), now, id],
        );
        return this.findById(id);
      },
    },

    worktrees: {
      async findByAgentId(agentId: string): Promise<WorktreeRecord | null> {
        const result = await db.query<WorktreeRow>(
          `select id, workspace_id, agent_id, repo_root, branch, path, base_ref, status, last_validated_at, created_at, updated_at from agent_worktrees where agent_id = ?`,
          [agentId],
        );
        return result.rows[0] ? mapWorktree(result.rows[0]) : null;
      },
      async upsert(worktree): Promise<WorktreeRecord> {
        await db.query(
          `insert into agent_worktrees (
            id, workspace_id, agent_id, repo_root, branch, path, base_ref, status, last_validated_at, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(agent_id) do update set
            repo_root = excluded.repo_root,
            branch = excluded.branch,
            path = excluded.path,
            base_ref = excluded.base_ref,
            status = excluded.status,
            last_validated_at = excluded.last_validated_at,
            updated_at = excluded.updated_at`,
          [
            worktree.id,
            worktree.workspaceId,
            worktree.agentId,
            worktree.repoRoot,
            worktree.branch,
            worktree.path,
            worktree.baseRef,
            worktree.status,
            worktree.lastValidatedAt,
            worktree.createdAt,
            worktree.updatedAt,
          ],
        );
        const refreshed = await this.findByAgentId(worktree.agentId);
        if (!refreshed) throw new Error(`Failed to persist worktree for agent ${worktree.agentId}`);
        return refreshed;
      },
      async deleteByAgentId(agentId: string): Promise<boolean> {
        const result = await db.query(`delete from agent_worktrees where agent_id = ?`, [agentId]);
        return result.rowCount > 0;
      },
    },

    runs: {
      async listByAgent(agentId: string): Promise<AgentRunRecord[]> {
        const result = await db.query<AgentRunRow>(
          `select id, workspace_id, agent_id, title, prompt, state, error_message, created_at, updated_at, started_at, completed_at
           from agent_runs where agent_id = ? order by created_at desc`,
          [agentId],
        );
        return result.rows.map(mapRun);
      },
      async listLatestBatchForAgents(agentIds: string[], limitPerAgent: number): Promise<AgentRunRecord[]> {
        if (agentIds.length === 0) return [];
        const placeholders = agentIds.map(() => "?").join(", ");
        const result = await db.query<AgentRunRow>(
          `select id, workspace_id, agent_id, title, prompt, state, error_message, created_at, updated_at, started_at, completed_at
           from agent_runs
           where agent_id in (${placeholders})
           order by agent_id, created_at desc`,
          [...agentIds],
        );
        // Group by agentId and keep at most limitPerAgent per agent
        const grouped = new Map<string, AgentRunRow[]>();
        for (const row of result.rows) {
          const group = grouped.get(row.agent_id) ?? [];
          if (group.length < limitPerAgent) {
            group.push(row);
          }
          grouped.set(row.agent_id, group);
        }
        return [...grouped.values()].flat().map(mapRun);
      },
      async findById(id: string): Promise<AgentRunRecord | null> {
        const result = await db.query<AgentRunRow>(
          `select id, workspace_id, agent_id, title, prompt, state, error_message, created_at, updated_at, started_at, completed_at
           from agent_runs where id = ?`,
          [id],
        );
        return result.rows[0] ? mapRun(result.rows[0]) : null;
      },
      async findActiveByAgent(agentId: string): Promise<AgentRunRecord | null> {
        const result = await db.query<AgentRunRow>(
          `select id, workspace_id, agent_id, title, prompt, state, error_message, created_at, updated_at, started_at, completed_at
           from agent_runs
           where agent_id = ? and state in ('CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL')
           order by created_at desc limit 1`,
          [agentId],
        );
        return result.rows[0] ? mapRun(result.rows[0]) : null;
      },
      async findQueuedForAgent(agentId: string): Promise<AgentRunRecord | null> {
        const result = await db.query<AgentRunRow>(
          `select id, workspace_id, agent_id, title, prompt, state, error_message, created_at, updated_at, started_at, completed_at
           from agent_runs
           where agent_id = ? and state = 'QUEUED'
           order by created_at desc limit 1`,
          [agentId],
        );
        return result.rows[0] ? mapRun(result.rows[0]) : null;
      },
      async create(run): Promise<AgentRunRecord> {
        await db.query(
          `insert into agent_runs (id, workspace_id, agent_id, title, prompt, state, error_message, created_at, updated_at, started_at, completed_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            run.id,
            run.workspaceId,
            run.agentId,
            run.title,
            run.prompt,
            run.state,
            run.errorMessage ?? null,
            run.createdAt,
            run.updatedAt,
            run.startedAt,
            run.completedAt ?? null,
          ],
        );
        const refreshed = await this.findById(run.id);
        if (!refreshed) throw new Error(`Failed to create run ${run.id}`);
        return refreshed;
      },
      async updateState(id, input): Promise<AgentRunRecord | null> {
        const existing = await this.findById(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        await db.query(
          `update agent_runs set state = ?, error_message = ?, completed_at = ?, updated_at = ? where id = ?`,
          [input.state, input.errorMessage ?? null, input.completedAt ?? null, now, id],
        );
        return this.findById(id);
      },
    },

    transcript: {
      async listByRun(runId: string): Promise<TranscriptEntryRecord[]> {
        const result = await db.query<TranscriptEntryRow>(
          `select id, run_id, workspace_id, agent_id, seq, entry_type, content, metadata, created_at
           from transcript_entries where run_id = ? order by seq asc`,
          [runId],
        );
        return result.rows.map(mapTranscriptEntry);
      },
      async listByRunLimited(runId: string, lastN: number): Promise<TranscriptEntryRecord[]> {
        const clampedN = Math.min(Math.max(1, lastN), 200);
        const result = await db.query<TranscriptEntryRow>(
          `select id, run_id, workspace_id, agent_id, seq, entry_type, content, metadata, created_at
           from transcript_entries
           where run_id = ? and entry_type in ('assistant', 'tool')
           order by seq desc limit ?`,
          [runId, clampedN],
        );
        // Return in ascending order
        return result.rows.reverse().map(mapTranscriptEntry);
      },
      async listByRunSince(runId: string, sinceSeq: number, limit: number): Promise<TranscriptEntryRecord[]> {
        const clampedLimit = Math.min(Math.max(1, limit), 500);
        const result = await db.query<TranscriptEntryRow>(
          `select id, run_id, workspace_id, agent_id, seq, entry_type, content, metadata, created_at
           from transcript_entries
           where run_id = ? and seq > ?
           order by seq asc limit ?`,
          [runId, sinceSeq, clampedLimit],
        );
        return result.rows.map(mapTranscriptEntry);
      },
      async maxSeq(runId: string): Promise<number> {
        const result = await db.query<{ max_seq: number | null }>(
          `select max(seq) as max_seq from transcript_entries where run_id = ?`,
          [runId],
        );
        return result.rows[0]?.max_seq ?? 0;
      },
      async listLatestBatchForRuns(runIds: string[], limitPerRun: number): Promise<TranscriptEntryRecord[]> {
        if (runIds.length === 0) return [];
        const placeholders = runIds.map(() => "?").join(", ");
        // Order DESC to get the latest entries first, then slice to limitPerRun per run.
        // We reverse each group back to ASC order before returning so callers get
        // chronological ordering within each run.
        const result = await db.query<TranscriptEntryRow>(
          `select id, run_id, workspace_id, agent_id, seq, entry_type, content, metadata, created_at
           from transcript_entries
           where run_id in (${placeholders})
           order by run_id, seq desc`,
          [...runIds],
        );
        // Group by runId, keeping the first limitPerRun rows per run (= the latest entries)
        const grouped = new Map<string, TranscriptEntryRow[]>();
        for (const row of result.rows) {
          const group = grouped.get(row.run_id) ?? [];
          if (group.length < limitPerRun) {
            group.push(row);
          }
          grouped.set(row.run_id, group);
        }
        // Reverse each group back to ascending (chronological) order
        return [...grouped.values()].flatMap((group) => group.reverse().map(mapTranscriptEntry));
      },
      async append(entry): Promise<TranscriptEntryRecord> {
        const seq = entry.seq ?? (await getNextTranscriptSequence(db, entry.runId));
        const createdAt = entry.createdAt;
        await db.query(
          `insert into transcript_entries (id, run_id, workspace_id, agent_id, seq, entry_type, content, metadata, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id,
            entry.runId,
            entry.workspaceId,
            entry.agentId,
            seq,
            entry.entryType,
            entry.content,
            JSON.stringify(entry.metadata ?? {}),
            createdAt,
          ],
        );
        const result = await db.query<TranscriptEntryRow>(
          `select id, run_id, workspace_id, agent_id, seq, entry_type, content, metadata, created_at from transcript_entries where id = ?`,
          [entry.id],
        );
        return mapTranscriptEntry(result.rows[0]);
      },
    },

    toolCalls: {
      async listByRun(runId: string): Promise<ToolCallRecord[]> {
        const result = await db.query<ToolCallRow>(
          `select id, run_id, workspace_id, agent_id, provider_call_id, approval_id, tool_name, status, input, output, requested_cwd, created_at, updated_at
           from tool_calls where run_id = ? order by created_at asc`,
          [runId],
        );
        return result.rows.map(mapToolCall);
      },
      async findById(id: string): Promise<ToolCallRecord | null> {
        const result = await db.query<ToolCallRow>(
          `select id, run_id, workspace_id, agent_id, provider_call_id, approval_id, tool_name, status, input, output, requested_cwd, created_at, updated_at
           from tool_calls where id = ?`,
          [id],
        );
        return result.rows[0] ? mapToolCall(result.rows[0]) : null;
      },
      async create(call): Promise<ToolCallRecord> {
        await db.query(
          `insert into tool_calls (id, run_id, workspace_id, agent_id, provider_call_id, approval_id, tool_name, status, input, output, requested_cwd, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            call.id,
            call.runId,
            call.workspaceId,
            call.agentId,
            call.providerCallId ?? null,
            call.approvalId ?? null,
            call.toolName,
            call.status,
            JSON.stringify(call.input),
            call.output ? JSON.stringify(call.output) : null,
            call.requestedCwd ?? null,
            call.createdAt,
            call.updatedAt,
          ],
        );
        const refreshed = await this.findById(call.id);
        if (!refreshed) throw new Error(`Failed to create tool call ${call.id}`);
        return refreshed;
      },
      async update(id, input): Promise<ToolCallRecord | null> {
        const existing = await this.findById(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        await db.query(
          `update tool_calls set provider_call_id = ?, approval_id = ?, status = ?, output = ?, requested_cwd = ?, updated_at = ? where id = ?`,
          [
            input.providerCallId ?? existing.providerCallId ?? null,
            input.approvalId ?? existing.approvalId ?? null,
            input.status ?? existing.status,
            input.output ? JSON.stringify(input.output) : existing.output ? JSON.stringify(existing.output) : null,
            input.requestedCwd ?? existing.requestedCwd ?? null,
            now,
            id,
          ],
        );
        return this.findById(id);
      },
    },

    approvals: {
      async listPending(workspaceId?: string): Promise<ApprovalRequestRecord[]> {
        const result = await db.query<ApprovalRow>(
          `select id, run_id, workspace_id, agent_id, tool_call_id, status, requested_action, requested_payload, reason, decision_message, created_at, decided_at
           from approval_requests
           where status = 'PENDING' ${workspaceId ? 'and workspace_id = ?' : ''}
           order by created_at asc`,
          workspaceId ? [workspaceId] : [],
        );
        return result.rows.map(mapApproval);
      },
      async findById(id: string): Promise<ApprovalRequestRecord | null> {
        const result = await db.query<ApprovalRow>(
          `select id, run_id, workspace_id, agent_id, tool_call_id, status, requested_action, requested_payload, reason, decision_message, created_at, decided_at
           from approval_requests where id = ?`,
          [id],
        );
        return result.rows[0] ? mapApproval(result.rows[0]) : null;
      },
      async create(approval): Promise<ApprovalRequestRecord> {
        await db.query(
          `insert into approval_requests (id, run_id, workspace_id, agent_id, tool_call_id, status, requested_action, requested_payload, reason, decision_message, created_at, decided_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            approval.id,
            approval.runId,
            approval.workspaceId,
            approval.agentId,
            approval.toolCallId,
            approval.status,
            approval.requestedAction,
            JSON.stringify(approval.requestedPayload),
            approval.reason ?? null,
            approval.decisionMessage ?? null,
            approval.createdAt,
            approval.decidedAt ?? null,
          ],
        );
        const refreshed = await this.findById(approval.id);
        if (!refreshed) throw new Error(`Failed to create approval ${approval.id}`);
        return refreshed;
      },
      async resolve(id, status, decisionMessage): Promise<ApprovalRequestRecord | null> {
        const existing = await this.findById(id);
        if (!existing) return null;
        const decidedAt = new Date().toISOString();
        await db.query(
          `update approval_requests set status = ?, decision_message = ?, decided_at = ? where id = ?`,
          [status, decisionMessage ?? null, decidedAt, id],
        );
        return this.findById(id);
      },
    },

    handoffs: {
      async listByWorkspace(workspaceId: string): Promise<HandoffItemRecord[]> {
        const result = await db.query<HandoffRow>(
          `select id, workspace_id, source_agent_id, source_run_id, assigned_agent_id, title, summary, recommended_provider, recommended_model, next_prompt, artifact_ids, auto_assign, status, created_at, updated_at
           from handoff_items where workspace_id = ? order by created_at desc`,
          [workspaceId],
        );
        return result.rows.map(mapHandoff);
      },
      async findById(id: string): Promise<HandoffItemRecord | null> {
        const result = await db.query<HandoffRow>(
          `select id, workspace_id, source_agent_id, source_run_id, assigned_agent_id, title, summary, recommended_provider, recommended_model, next_prompt, artifact_ids, auto_assign, status, created_at, updated_at
           from handoff_items where id = ?`,
          [id],
        );
        return result.rows[0] ? mapHandoff(result.rows[0]) : null;
      },
      async create(handoff): Promise<HandoffItemRecord> {
        await db.query(
          `insert into handoff_items (id, workspace_id, source_agent_id, source_run_id, assigned_agent_id, title, summary, recommended_provider, recommended_model, next_prompt, artifact_ids, auto_assign, status, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            handoff.id,
            handoff.workspaceId,
            handoff.sourceAgentId,
            handoff.sourceRunId,
            handoff.assignedAgentId ?? null,
            handoff.title,
            handoff.summary,
            handoff.recommendedProvider,
            handoff.recommendedModel,
            handoff.nextPrompt,
            JSON.stringify(handoff.artifactIds),
            handoff.autoAssign ? 1 : 0,
            handoff.status,
            handoff.createdAt,
            handoff.updatedAt,
          ],
        );
        const refreshed = await this.findById(handoff.id);
        if (!refreshed) throw new Error(`Failed to create handoff ${handoff.id}`);
        return refreshed;
      },
      async assign(id, assignedAgentId): Promise<HandoffItemRecord | null> {
        const existing = await this.findById(id);
        if (!existing) return null;
        const updatedAt = new Date().toISOString();
        await db.query(
          `update handoff_items set assigned_agent_id = ?, status = 'ASSIGNED', updated_at = ? where id = ?`,
          [assignedAgentId, updatedAt, id],
        );
        return this.findById(id);
      },
      async updateStatus(id, status): Promise<HandoffItemRecord | null> {
        const existing = await this.findById(id);
        if (!existing) return null;
        const updatedAt = new Date().toISOString();
        await db.query(`update handoff_items set status = ?, updated_at = ? where id = ?`, [status, updatedAt, id]);
        return this.findById(id);
      },
    },

    coordination: {
      async findByWorkspaceId(workspaceId: string): Promise<CoordinationStateRecord | null> {
        const result = await db.query<CoordinationStateRow>(
          `select workspace_id, brief, agent_briefs, handoff_summaries, finding_summaries, action_requests, team_ask,
                  dependency_graph, execution_plan, blocked_agents, coordinator_decisions, reply_packets, team_ask_history,
                  current_prompt_id, coordinator_usage, created_at, updated_at
           from workspace_coordination_states
           where workspace_id = ?`,
          [workspaceId],
        );

        return result.rows[0] ? mapCoordinationState(result.rows[0]) : null;
      },

      async upsert(state: CoordinationStateRecord): Promise<CoordinationStateRecord> {
        const now = state.updatedAt || new Date().toISOString();
        await db.query(
          `insert into workspace_coordination_states (
            workspace_id, brief, agent_briefs, handoff_summaries, finding_summaries, action_requests, team_ask,
            dependency_graph, execution_plan, blocked_agents, coordinator_decisions, reply_packets, team_ask_history,
            current_prompt_id, coordinator_usage, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(workspace_id) do update set
            brief = excluded.brief,
            agent_briefs = excluded.agent_briefs,
            handoff_summaries = excluded.handoff_summaries,
            finding_summaries = excluded.finding_summaries,
            action_requests = excluded.action_requests,
            team_ask = excluded.team_ask,
            dependency_graph = excluded.dependency_graph,
            execution_plan = excluded.execution_plan,
            blocked_agents = excluded.blocked_agents,
            coordinator_decisions = excluded.coordinator_decisions,
            reply_packets = excluded.reply_packets,
            team_ask_history = excluded.team_ask_history,
            current_prompt_id = excluded.current_prompt_id,
            coordinator_usage = excluded.coordinator_usage,
            updated_at = excluded.updated_at`,
          [
            state.workspaceId,
            JSON.stringify(state.brief),
            JSON.stringify(state.agentBriefs),
            JSON.stringify(state.handoffSummaries),
            JSON.stringify(state.findingSummaries),
            JSON.stringify(state.actionRequests),
            JSON.stringify(state.teamAsk),
            JSON.stringify(state.dependencyGraph),
            JSON.stringify(state.executionPlan),
            JSON.stringify(state.blockedAgents),
            JSON.stringify(state.coordinatorDecisions),
            JSON.stringify(state.replyPackets),
            JSON.stringify(state.teamAskHistory),
            state.currentPromptId,
            state.coordinatorUsage ? JSON.stringify(state.coordinatorUsage) : null,
            now,
            now,
          ],
        );

        const refreshed = await this.findByWorkspaceId(state.workspaceId);
        if (!refreshed) {
          throw new Error(`Failed to persist workspace coordination state for ${state.workspaceId}`);
        }
        return refreshed;
      },

      async dismissTeamAsk(workspaceId: string): Promise<void> {
        const existing = await this.findByWorkspaceId(workspaceId);
        if (!existing?.teamAsk) return;
        const dismissed = { ...existing.teamAsk, dismissed: true };
        await db.query(
          `update workspace_coordination_states set team_ask = ?, updated_at = ? where workspace_id = ?`,
          [JSON.stringify(dismissed), new Date().toISOString(), workspaceId],
        );
      },
    },

    contexts: {
      async list(workspaceId?: string): Promise<ContextPackRecord[]> {
        const packResult = await db.query<ContextPackRow>(
          `select id, workspace_id, name, description, version, immutable, created_at
           from context_packs ${workspaceId ? 'where workspace_id = ?' : ''}
           order by created_at desc`,
          workspaceId ? [workspaceId] : [],
        );
        if (packResult.rows.length === 0) return [];
        const packIds = packResult.rows.map((row) => row.id);
        const itemResult = await db.query<ContextItemRow>(
          `select id, context_pack_id, item_type, value, checksum, token_estimate, created_at
           from context_items
           where context_pack_id in (${buildInClause(packIds)})
           order by created_at asc`,
          packIds,
        );
        const itemsByPack = new Map<string, ContextItemRecord[]>();
        for (const row of itemResult.rows) {
          const currentItems = itemsByPack.get(row.context_pack_id) ?? [];
          currentItems.push(mapContextItem(row));
          itemsByPack.set(row.context_pack_id, currentItems);
        }
        return packResult.rows.map((row) => mapContextPack(row, itemsByPack.get(row.id) ?? []));
      },
      async findById(id: string): Promise<ContextPackRecord | null> {
        const packResult = await db.query<ContextPackRow>(
          `select id, workspace_id, name, description, version, immutable, created_at from context_packs where id = ?`,
          [id],
        );
        if (!packResult.rows[0]) return null;
        const itemResult = await db.query<ContextItemRow>(
          `select id, context_pack_id, item_type, value, checksum, token_estimate, created_at from context_items where context_pack_id = ? order by created_at asc`,
          [id],
        );
        return mapContextPack(packResult.rows[0], itemResult.rows.map(mapContextItem));
      },
      async create(contextPack): Promise<ContextPackRecord> {
        await db.transaction(async (client) => {
          await client.query(
            `insert into context_packs (id, workspace_id, name, description, version, immutable, created_at)
             values (?, ?, ?, ?, ?, ?, ?)`,
            [
              contextPack.id,
              contextPack.workspaceId,
              contextPack.name,
              contextPack.description,
              contextPack.version,
              contextPack.immutable ? 1 : 0,
              contextPack.createdAt,
            ],
          );
          for (const item of contextPack.items) {
            await client.query(
              `insert into context_items (id, context_pack_id, item_type, value, checksum, token_estimate, created_at)
               values (?, ?, ?, ?, ?, ?, ?)`,
              [item.id, contextPack.id, item.type, item.value, item.checksum, item.tokenEstimate, contextPack.createdAt],
            );
          }
        });
        const createdPack = await this.findById(contextPack.id);
        if (!createdPack) throw new Error(`Failed to create context pack ${contextPack.id}`);
        return createdPack;
      },
      async mount(contextPackId, agentIds, maxContextTokens): Promise<number> {
        if (agentIds.length === 0) return 0;
        const mountedAt = new Date().toISOString();
        let mountedCount = 0;
        await db.transaction(async (client) => {
          for (const agentId of agentIds) {
            const result = await client.query(
              `insert into agent_context_mounts (agent_id, context_pack_id, mounted_at, max_context_tokens)
               values (?, ?, ?, ?)
               on conflict(agent_id, context_pack_id)
               do update set mounted_at = excluded.mounted_at, max_context_tokens = excluded.max_context_tokens`,
              [agentId, contextPackId, mountedAt, maxContextTokens ?? null],
            );
            mountedCount += result.rowCount;
          }
        });
        return mountedCount;
      },
      async listMountedItems(agentId: string): Promise<ContextItemRecord[]> {
        const itemResult = await db.query<ContextItemRow>(
          `select item.id, item.context_pack_id, item.item_type, item.value, item.checksum, item.token_estimate, item.created_at
           from agent_context_mounts mount
           inner join context_items item on item.context_pack_id = mount.context_pack_id
           where mount.agent_id = ?
           order by mount.mounted_at asc, item.created_at asc`,
          [agentId],
        );
        return itemResult.rows.map(mapContextItem);
      },
    },

    usage: {
      async getSummary(workspaceId?: string): Promise<UsageRollup> {
        const agentCountResult = await db.query<UsageRollupRow>(
          `select count(*) as total_agents from agent_sessions ${workspaceId ? 'where workspace_id = ?' : ''}`,
          workspaceId ? [workspaceId] : [],
        );
        const usageResult = await db.query<UsageRollupRow>(
          `select coalesce(sum(input_tokens), 0) as total_input_tokens,
                  coalesce(sum(output_tokens), 0) as total_output_tokens,
                  coalesce(sum(cost_usd), 0) as total_cost_usd
           from usage_ticks ${workspaceId ? 'where workspace_id = ?' : ''}`,
          workspaceId ? [workspaceId] : [],
        );
        return {
          totalAgents: toNumber(agentCountResult.rows[0]?.total_agents),
          totalCostUsd: toNumber(usageResult.rows[0]?.total_cost_usd),
          totalInputTokens: toNumber(usageResult.rows[0]?.total_input_tokens),
          totalOutputTokens: toNumber(usageResult.rows[0]?.total_output_tokens),
        };
      },
    },

    artifacts: {
      async listByAgent(agentId: string): Promise<ArtifactRecord[]> {
        const result = await db.query<ArtifactRow>(
          `select id, workspace_id, agent_id, run_id, kind, uri, size_bytes, created_at
           from artifacts where agent_id = ? order by created_at desc`,
          [agentId],
        );
        return result.rows.map(mapArtifact);
      },
      async listByRun(runId: string): Promise<ArtifactRecord[]> {
        const result = await db.query<ArtifactRow>(
          `select id, workspace_id, agent_id, run_id, kind, uri, size_bytes, created_at
           from artifacts where run_id = ? order by created_at desc`,
          [runId],
        );
        return result.rows.map(mapArtifact);
      },
      async create(artifact): Promise<ArtifactRecord> {
        await db.query(
          `insert into artifacts (id, agent_id, workspace_id, run_id, kind, uri, size_bytes, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
          [artifact.id, artifact.agentId, artifact.workspaceId, artifact.runId ?? null, artifact.kind, artifact.uri, artifact.sizeBytes ?? null, artifact.createdAt],
        );
        const result = await db.query<ArtifactRow>(
          `select id, workspace_id, agent_id, run_id, kind, uri, size_bytes, created_at from artifacts where id = ?`,
          [artifact.id],
        );
        return mapArtifact(result.rows[0]);
      },
    },

    memory: {
      async upsert(block: AgentMemoryBlockRecord): Promise<AgentMemoryBlockRecord> {
        const now = new Date().toISOString();
        await db.query(
          `INSERT INTO agent_memory_blocks (id, workspace_id, agent_id, key, value, scope, expires_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(agent_id, key) DO UPDATE SET
             value = excluded.value,
             scope = excluded.scope,
             expires_at = excluded.expires_at,
             version = agent_memory_blocks.version + 1,
             updated_at = excluded.updated_at`,
          [block.id, block.workspaceId, block.agentId, block.key, block.value, block.scope, block.expiresAt ?? null, block.createdAt, now],
        );
        const result = await db.query<MemoryBlockRow>(
          `SELECT id, workspace_id, agent_id, key, value, scope, expires_at, version, created_at, updated_at FROM agent_memory_blocks WHERE agent_id = ? AND key = ?`,
          [block.agentId, block.key],
        );
        if (!result.rows[0]) throw new Error(`Failed to upsert memory block ${block.agentId}:${block.key}`);
        return mapMemoryBlock(result.rows[0]);
      },
      async listForAgent(agentId: string): Promise<AgentMemoryBlockRecord[]> {
        const now = new Date().toISOString();
        const result = await db.query<MemoryBlockRow>(
          `SELECT id, workspace_id, agent_id, key, value, scope, expires_at, version, created_at, updated_at
           FROM agent_memory_blocks
           WHERE agent_id = ? AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY key ASC`,
          [agentId, now],
        );
        return result.rows.map(mapMemoryBlock);
      },
      async listWorkspaceScoped(workspaceId: string): Promise<AgentMemoryBlockRecord[]> {
        const now = new Date().toISOString();
        const result = await db.query<MemoryBlockRow>(
          `SELECT id, workspace_id, agent_id, key, value, scope, expires_at, version, created_at, updated_at
           FROM agent_memory_blocks
           WHERE workspace_id = ? AND scope = 'workspace' AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY agent_id, key ASC`,
          [workspaceId, now],
        );
        return result.rows.map(mapMemoryBlock);
      },
      async findByAgentAndKey(agentId: string, key: string): Promise<AgentMemoryBlockRecord | null> {
        const result = await db.query<MemoryBlockRow>(
          `SELECT id, workspace_id, agent_id, key, value, scope, expires_at, version, created_at, updated_at FROM agent_memory_blocks WHERE agent_id = ? AND key = ?`,
          [agentId, key],
        );
        return result.rows[0] ? mapMemoryBlock(result.rows[0]) : null;
      },
      async deleteByAgentAndKey(agentId: string, key: string): Promise<boolean> {
        await db.query(
          `DELETE FROM agent_memory_blocks WHERE agent_id = ? AND key = ?`,
          [agentId, key],
        );
        return true;
      },
      async purgeExpired(): Promise<number> {
        const now = new Date().toISOString();
        const result = await db.query<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM agent_memory_blocks WHERE expires_at IS NOT NULL AND expires_at <= ?`,
          [now],
        );
        const count = result.rows[0]?.cnt ?? 0;
        await db.query(`DELETE FROM agent_memory_blocks WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now]);
        return Number(count);
      },
    },

    messages: {
      async send(message: AgentMessageRecord): Promise<AgentMessageRecord> {
        await db.query(
          `INSERT INTO agent_messages (id, workspace_id, from_agent_id, to_agent_id, subject, content, read_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [message.id, message.workspaceId, message.fromAgentId, message.toAgentId, message.subject, message.content, message.readAt ?? null, message.createdAt],
        );
        const result = await db.query<AgentMessageRow>(
          `SELECT id, workspace_id, from_agent_id, to_agent_id, subject, content, read_at, created_at FROM agent_messages WHERE id = ?`,
          [message.id],
        );
        if (!result.rows[0]) throw new Error(`Failed to create message ${message.id}`);
        return mapAgentMessage(result.rows[0]);
      },
      async listUnreadForAgent(agentId: string): Promise<AgentMessageRecord[]> {
        const result = await db.query<AgentMessageRow>(
          `SELECT id, workspace_id, from_agent_id, to_agent_id, subject, content, read_at, created_at FROM agent_messages WHERE to_agent_id = ? AND read_at IS NULL ORDER BY created_at ASC`,
          [agentId],
        );
        return result.rows.map(mapAgentMessage);
      },
      async markRead(messageId: string, agentId: string): Promise<AgentMessageRecord | null> {
        const existing = await this.findById(messageId);
        if (!existing || existing.toAgentId !== agentId) return null;
        const readAt = new Date().toISOString();
        await db.query(`UPDATE agent_messages SET read_at = ? WHERE id = ?`, [readAt, messageId]);
        return this.findById(messageId);
      },
      async findById(id: string): Promise<AgentMessageRecord | null> {
        const result = await db.query<AgentMessageRow>(
          `SELECT id, workspace_id, from_agent_id, to_agent_id, subject, content, read_at, created_at FROM agent_messages WHERE id = ?`,
          [id],
        );
        return result.rows[0] ? mapAgentMessage(result.rows[0]) : null;
      },
      async verifySameWorkspace(fromAgentId: string, toAgentId: string): Promise<boolean> {
        const result = await db.query<QueryResultRow>(
          `SELECT COUNT(*) AS cnt FROM agent_sessions WHERE id IN (?, ?) GROUP BY workspace_id HAVING COUNT(*) = 2`,
          [fromAgentId, toAgentId],
        );
        return (result.rows[0]?.cnt as number | undefined) === 2;
      },
    },
  };
}
