import type {
  ApprovalRequestRecord,
  ArtifactRecord,
  AgentRunRecord,
  AgentEventRecord,
  AgentSessionRecord,
  CoordinationBriefRecord,
  CoordinationStateRecord,
  RenderedCoordinationPacketRecord,
  HandoffItemRecord,
  ProjectFileCandidateRecord,
  TaskPlanningSuggestion,
  ToolCallRecord,
  TranscriptEntryRecord,
  UsageRollup,
  WorktreeRecord,
  WorkspaceOverviewRecord,
  WorkspaceRecord,
} from "@acc/shared-types";
import { invoke } from "@tauri-apps/api/core";

const defaultBaseUrl = "http://127.0.0.1:7711";

function getBaseUrl(): string {
  return import.meta.env.VITE_CONTROL_PLANE_URL ?? defaultBaseUrl;
}

async function requestJson<TResponse>(path: string, init?: RequestInit): Promise<TResponse> {
  const headers = new Headers(init?.headers);

  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.text();

    if (body) {
      let parsedMessage: string | undefined;

      try {
        const parsed = JSON.parse(body) as { error?: string; message?: string };
        parsedMessage = parsed.message ?? parsed.error;
      } catch {
        parsedMessage = undefined;
      }

      throw new Error(parsedMessage ?? body);
    }

    throw new Error(`Request failed with ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  return response.json() as Promise<TResponse>;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  env: string;
  now: string;
  autoMigrate: boolean;
}

export function getControlPlaneBaseUrl(): string {
  return getBaseUrl();
}

export interface ProviderSettingsStatus {
  openaiConfigured: boolean;
  anthropicConfigured: boolean;
  appliedToEmbeddedControlPlane: boolean;
}

export interface ControlPlaneRuntimeStatus {
  reachable: boolean;
  appOwned: boolean;
  lastError: string | null;
}

export interface FileTreeNodeRecord {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileTreeNodeRecord[];
  truncated?: boolean;
}

export interface TextFilePreviewRecord {
  path: string;
  content: string;
  truncated: boolean;
}

export interface TerminalCommandResultRecord {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getControlPlaneStreamUrl(workspaceId: string): string {
  const url = new URL("/api/v1/stream", getBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("workspaceId", workspaceId);
  return url.toString();
}

export async function fetchHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/health");
}

export async function fetchWorkspaces(): Promise<WorkspaceRecord[]> {
  const response = await requestJson<{ workspaces: WorkspaceRecord[] }>("/api/v1/workspaces");
  return response.workspaces;
}

export async function fetchWorkspaceOverview(workspaceId: string): Promise<WorkspaceOverviewRecord> {
  return requestJson<WorkspaceOverviewRecord>(`/api/v1/workspaces/${workspaceId}`);
}

export async function fetchWorkspaceCoordination(workspaceId: string): Promise<CoordinationStateRecord | null> {
  const response = await requestJson<{
    workspaceId: string;
    coordinationState: CoordinationStateRecord | null;
  }>(`/api/v1/workspaces/${workspaceId}/coordination`);

  return response.coordinationState;
}

export async function fetchRenderedCoordinationPacket(
  workspaceId: string,
  options?: {
    agentId?: string;
    role?: string;
    title?: string;
  },
): Promise<RenderedCoordinationPacketRecord | null> {
  const query = new URLSearchParams();

  if (options?.agentId) {
    query.set("agentId", options.agentId);
  }

  if (options?.role) {
    query.set("role", options.role);
  }

  if (options?.title) {
    query.set("title", options.title);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await requestJson<{
    workspaceId: string;
    packet: RenderedCoordinationPacketRecord | null;
  }>(`/api/v1/workspaces/${workspaceId}/coordination/render${suffix}`);

  return response.packet;
}

export async function fetchWorkspaceEvents(
  workspaceId: string,
  options?: {
    agentId?: string;
    limit?: number;
  },
): Promise<AgentEventRecord[]> {
  const query = new URLSearchParams();

  if (options?.agentId) {
    query.set("agentId", options.agentId);
  }

  if (typeof options?.limit === "number") {
    query.set("limit", String(options.limit));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await requestJson<{ events: AgentEventRecord[] }>(
    `/api/v1/workspaces/${workspaceId}/events${suffix}`,
  );
  return response.events;
}

export async function createWorkspace(input: {
  name: string;
  description?: string;
  projectRoot?: string;
  sharedContext?: string;
}): Promise<WorkspaceRecord> {
  const response = await requestJson<{ workspace: WorkspaceRecord }>("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  });

  return response.workspace;
}

export async function updateWorkspace(
  workspaceId: string,
  input: {
    name?: string;
    description?: string;
    projectRoot?: string;
    sharedContext?: string;
    coordinationBrief?: CoordinationBriefRecord | null;
  },
): Promise<WorkspaceRecord> {
  const response = await requestJson<{ workspace: WorkspaceRecord }>(`/api/v1/workspaces/${workspaceId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });

  return response.workspace;
}

export async function updateWorkspaceCoordination(
  workspaceId: string,
  input: { brief: CoordinationBriefRecord | null },
): Promise<CoordinationStateRecord | null> {
  const response = await requestJson<{
    workspaceId: string;
    coordinationState: CoordinationStateRecord | null;
  }>(`/api/v1/workspaces/${workspaceId}/coordination`, {
    method: "PUT",
    body: JSON.stringify(input),
  });

  return response.coordinationState;
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await requestJson(`/api/v1/workspaces/${workspaceId}`, {
    method: "DELETE",
  });
}

export async function bootstrapDemoWorkspace(workspaceId: string): Promise<{
  workspaceId: string;
  createdAgents: number;
  createdContextPacks: number;
}> {
  return requestJson(`/api/v1/workspaces/${workspaceId}/bootstrap-demo`, {
    method: "POST",
  });
}

export async function fetchUsage(workspaceId: string): Promise<UsageRollup> {
  const response = await requestJson<{ window: "1h" | "24h"; summary: UsageRollup }>(
    `/api/v1/usage?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return response.summary;
}

export async function fetchAgentEvents(agentId: string): Promise<AgentEventRecord[]> {
  const response = await requestJson<{ events: AgentEventRecord[] }>(`/api/v1/agents/${agentId}/events`);
  return response.events;
}

export async function fetchAgentArtifacts(agentId: string): Promise<ArtifactRecord[]> {
  const response = await requestJson<{ artifacts: ArtifactRecord[] }>(`/api/v1/agents/${agentId}/artifacts`);
  return response.artifacts;
}

export async function fetchAgentRuns(agentId: string): Promise<AgentRunRecord[]> {
  const response = await requestJson<{ runs: AgentRunRecord[] }>(`/api/v1/agents/${agentId}/runs`);
  return response.runs;
}

export async function createAgentRun(input: {
  agentId: string;
  prompt: string;
  title?: string;
}): Promise<AgentRunRecord> {
  const response = await requestJson<{ run: AgentRunRecord }>(`/api/v1/agents/${input.agentId}/runs`, {
    method: "POST",
    body: JSON.stringify({
      prompt: input.prompt,
      title: input.title,
    }),
  });
  return response.run;
}

export async function fetchRun(runId: string): Promise<AgentRunRecord> {
  const response = await requestJson<{ run: AgentRunRecord }>(`/api/v1/runs/${runId}`);
  return response.run;
}

export async function fetchRunTranscript(runId: string): Promise<TranscriptEntryRecord[]> {
  const response = await requestJson<{ transcript: TranscriptEntryRecord[] }>(`/api/v1/runs/${runId}/transcript`);
  return response.transcript;
}

export async function fetchRunToolCalls(runId: string): Promise<ToolCallRecord[]> {
  const response = await requestJson<{ toolCalls: ToolCallRecord[] }>(`/api/v1/runs/${runId}/tool-calls`);
  return response.toolCalls;
}

export async function fetchRunArtifacts(runId: string): Promise<ArtifactRecord[]> {
  const response = await requestJson<{ artifacts: ArtifactRecord[] }>(`/api/v1/runs/${runId}/artifacts`);
  return response.artifacts;
}

export async function stopRun(runId: string): Promise<AgentRunRecord> {
  const response = await requestJson<{ run: AgentRunRecord }>(`/api/v1/runs/${runId}/stop`, {
    method: "POST",
  });
  return response.run;
}

export async function fetchPendingApprovals(workspaceId?: string): Promise<ApprovalRequestRecord[]> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  const response = await requestJson<{ approvals: ApprovalRequestRecord[] }>(`/api/v1/approvals${query}`);
  return response.approvals;
}

export async function approveApproval(input: {
  approvalId: string;
  decisionMessage?: string;
}): Promise<ApprovalRequestRecord> {
  const response = await requestJson<{ approval: ApprovalRequestRecord }>(`/api/v1/approvals/${input.approvalId}/approve`, {
    method: "POST",
    body: JSON.stringify({
      decisionMessage: input.decisionMessage,
    }),
  });
  return response.approval;
}

export async function denyApproval(input: {
  approvalId: string;
  decisionMessage?: string;
}): Promise<ApprovalRequestRecord> {
  const response = await requestJson<{ approval: ApprovalRequestRecord }>(`/api/v1/approvals/${input.approvalId}/deny`, {
    method: "POST",
    body: JSON.stringify({
      decisionMessage: input.decisionMessage,
    }),
  });
  return response.approval;
}

export async function fetchWorkspaceInbox(workspaceId: string): Promise<{
  workspaceId: string;
  inbox: HandoffItemRecord[];
  approvals: ApprovalRequestRecord[];
}> {
  return requestJson(`/api/v1/workspaces/${workspaceId}/inbox`);
}

export async function assignHandoff(input: {
  handoffId: string;
  agentId: string;
}): Promise<HandoffItemRecord> {
  const response = await requestJson<{ handoff: HandoffItemRecord }>(`/api/v1/handoffs/${input.handoffId}/assign`, {
    method: "POST",
    body: JSON.stringify({
      agentId: input.agentId,
    }),
  });
  return response.handoff;
}

export async function updateHandoffStatus(input: {
  handoffId: string;
  status: HandoffItemRecord["status"];
}): Promise<HandoffItemRecord> {
  const response = await requestJson<{ handoff: HandoffItemRecord }>(`/api/v1/handoffs/${input.handoffId}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: input.status,
    }),
  });
  return response.handoff;
}

export async function createAgentFromHandoff(handoffId: string): Promise<AgentSessionRecord> {
  const response = await requestJson<{ agent: AgentSessionRecord }>(`/api/v1/handoffs/${handoffId}/create-agent`, {
    method: "POST",
  });
  return response.agent;
}

export async function fetchAgentWorktree(agentId: string): Promise<WorktreeRecord | null> {
  const response = await requestJson<{ worktree: WorktreeRecord | null }>(`/api/v1/agents/${agentId}/worktree`);
  return response.worktree;
}

export async function resetAgentWorktree(agentId: string): Promise<WorktreeRecord> {
  const response = await requestJson<{ worktree: WorktreeRecord }>(`/api/v1/agents/${agentId}/worktree/reset`, {
    method: "POST",
  });
  return response.worktree;
}

export async function createAgent(input: {
  workspaceId: string;
  provider: "codex" | "claude";
  model: string;
  title?: string;
  role?: string;
  task?: string;
  cwd?: string;
  systemPrompt?: string;
}): Promise<AgentSessionRecord> {
  const response = await requestJson<{ agent: AgentSessionRecord }>("/api/v1/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return response.agent;
}

export async function updateAgent(agentId: string, input: { title?: string; cwd?: string }): Promise<void> {
  await requestJson(`/api/v1/agents/${agentId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function startAgent(agentId: string): Promise<void> {
  await requestJson(`/api/v1/agents/${agentId}/start`, {
    method: "POST",
  });
}

export async function sendAgentInput(agentId: string, input: string): Promise<void> {
  await requestJson(`/api/v1/agents/${agentId}/input`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
}

export async function interruptAgent(agentId: string): Promise<void> {
  await requestJson(`/api/v1/agents/${agentId}/interrupt`, {
    method: "POST",
  });
}

export async function stopAgent(agentId: string): Promise<void> {
  await requestJson(`/api/v1/agents/${agentId}/stop`, {
    method: "POST",
  });
}

export async function mountContextPack(
  contextPackId: string,
  input: { agentIds: string[]; maxContextTokens?: number },
): Promise<void> {
  await requestJson(`/api/v1/contexts/${contextPackId}/mount`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchProjectFiles(workspaceId: string): Promise<{
  workspaceId: string;
  projectRoot: string;
  candidates: ProjectFileCandidateRecord[];
}> {
  return requestJson(`/api/v1/workspaces/${workspaceId}/project-files`);
}

export async function importSharedContextFromProject(
  workspaceId: string,
  input: { paths: string[]; mode: "append" | "replace" },
): Promise<{ workspace: WorkspaceRecord; importedFiles: string[]; mode: "append" | "replace" }> {
  return requestJson(`/api/v1/workspaces/${workspaceId}/shared-context/import`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchPlannerSuggestion(input: {
  workspaceId: string;
  provider: "codex" | "claude";
  model: string;
  task: string;
  constraints?: string;
}): Promise<TaskPlanningSuggestion> {
  const response = await requestJson<{ suggestion: TaskPlanningSuggestion }>("/api/v1/planner/suggest", {
    method: "POST",
    body: JSON.stringify(input),
  });

  return response.suggestion;
}

export async function fetchProviderSettings(): Promise<ProviderSettingsStatus> {
  if (!isTauriRuntime()) {
    return {
      openaiConfigured: false,
      anthropicConfigured: false,
      appliedToEmbeddedControlPlane: false,
    };
  }

  return invoke<ProviderSettingsStatus>("get_provider_settings");
}

export async function fetchControlPlaneRuntimeStatus(): Promise<ControlPlaneRuntimeStatus> {
  if (!isTauriRuntime()) {
    return {
      reachable: false,
      appOwned: false,
      lastError: null,
    };
  }

  return invoke<ControlPlaneRuntimeStatus>("get_control_plane_runtime_status");
}

export async function saveProviderSettings(input: {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  clearOpenai?: boolean;
  clearAnthropic?: boolean;
}): Promise<ProviderSettingsStatus> {
  if (!isTauriRuntime()) {
    throw new Error("Provider settings are only available in the desktop app.");
  }

  return invoke<ProviderSettingsStatus>("save_provider_settings", {
    request: input,
  });
}

export async function fetchProjectTree(root: string): Promise<FileTreeNodeRecord[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  return invoke<FileTreeNodeRecord[]>("list_project_tree", { root });
}

export async function readProjectFile(path: string): Promise<TextFilePreviewRecord> {
  if (!isTauriRuntime()) {
    throw new Error("File preview is only available in the desktop app.");
  }

  return invoke<TextFilePreviewRecord>("read_text_file", { path });
}

export async function writeProjectFile(path: string, content: string, allowedRoots?: string[]): Promise<TextFilePreviewRecord> {
  if (!isTauriRuntime()) {
    throw new Error("File editing is only available in the desktop app.");
  }

  return invoke<TextFilePreviewRecord>("write_text_file", { path, content, allowedRoots });
}

export async function runTerminalCommand(input: {
  cwd: string;
  command: string;
  allowedRoots?: string[];
}): Promise<TerminalCommandResultRecord> {
  if (!isTauriRuntime()) {
    throw new Error("Terminal commands are only available in the desktop app.");
  }

  return invoke<TerminalCommandResultRecord>("run_terminal_command", input);
}

export async function dispatchWorkspaceReply(
  workspaceId: string,
  input: { replyText: string; promptId: string; teamAskId?: string },
): Promise<{
  status: "dispatched" | "no_agents" | "all_blocked" | "stale_state";
  dispatchedRunIds: string[];
  blockedAgentIds: string[];
  reason?: string;
}> {
  return requestJson(`/api/v1/workspaces/${workspaceId}/coordination/dispatch`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
