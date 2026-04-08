import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { agentStateMeta, usageFormatters } from "@acc/ui-kit";
import type {
  ApprovalRequestRecord,
  ArtifactRecord,
  AgentEventRecord,
  AgentRunRecord,
  AgentSessionRecord,
  CoordinationBriefRecord,
  CoordinationStateRecord,
  ContextPackRecord,
  EventStreamMessage,
  HandoffItemRecord,
  ProjectFileCandidateRecord,
  TaskPlanningSuggestion,
  ToolCallRecord,
  TranscriptEntryRecord,
} from "@acc/shared-types";

import {
  approveApproval,
  assignHandoff,
  bootstrapDemoWorkspace,
  createAgent,
  createAgentFromHandoff,
  createAgentRun,
  createWorkspace,
  deleteWorkspace,
  dispatchWorkspaceReply,
  fetchAgentArtifacts,
  fetchAgentEvents,
  fetchAgentRuns,
  fetchControlPlaneRuntimeStatus,
  fetchPendingApprovals,
  fetchProviderSettings,
  fetchProjectTree,
  fetchProjectFiles,
  fetchRenderedCoordinationPacket,
  fetchHealth,
  fetchPlannerSuggestion,
  fetchRunArtifacts,
  fetchRunToolCalls,
  fetchRunTranscript,
  fetchWorkspaceInbox,
  fetchWorkspaceEvents,
  fetchWorkspaceOverview,
  fetchWorkspaces,
  getControlPlaneBaseUrl,
  getControlPlaneStreamUrl,
  importSharedContextFromProject,
  interruptAgent,
  isTauriRuntime,
  mountContextPack,
  resetAgentWorktree,
  stopRun,
  type FileTreeNodeRecord,
  type TerminalCommandResultRecord,
  readProjectFile,
  writeProjectFile,
  runTerminalCommand,
  saveProviderSettings,
  startAgent,
  stopAgent,
  updateHandoffStatus,
  updateAgent,
  updateWorkspaceCoordination,
  updateWorkspace,
  denyApproval,
  dismissTeamAsk,
} from "./lib/api";

type FilterId = "all" | "active" | "idle" | "errors";
type MenuId = "settings";
type HomeThreadKind = "workspace" | "planner" | "inbox" | "agent";
type HomeThread = { kind: HomeThreadKind; agentId?: string };
type InspectorTab = "session" | "ops" | "meta";
type NoticeTone = "info" | "success" | "error";
type RightSidebarTab = "files" | "terminal" | "artifacts" | "details";
type SettingsDrawerTab = "providers" | "runtime";
type ResizeTarget = "sidebar" | "inspector";
type FleetActivityTone = "info" | "warning" | "danger" | "success" | "muted";

type FleetActivityItem = {
  id: string;
  agentId: string;
  agentTitle: string;
  ts: string;
  summary: string;
  detail?: string;
  tone: FleetActivityTone;
  source: "broadcast" | "event" | "poll";
  runId?: string;
  eventType?: AgentEventRecord["type"];
  seq?: number;
  rawText?: string;
};

type WorkspaceThreadEntry = {
  id: string;
  ts: string;
  role: "user";
  title: string;
  content: string;
  scope: "visible" | "all" | "agent";
  agentId?: string;
  targetAgentIds?: string[];
};

type WorkspaceConversationReplyKind = "reply" | "error" | "rate_limit" | "needs_input" | "approval";

type WorkspaceConversationReply = {
  id: string;
  agentId: string;
  agentTitle: string;
  ts: string;
  kind: WorkspaceConversationReplyKind;
  content: string;
  detail?: string;
  streaming?: boolean;
  approval?: ApprovalRequestRecord;
  runId?: string;
  prompt?: string;
};

type WorkspaceInlineActionRequest = {
  content: string;
  detail: string;
  ts: string;
};

type WorkspaceAgentThread = {
  agentId: string;
  agentTitle: string;
  agentState: string;
  replies: WorkspaceConversationReply[];
  approvals: WorkspaceConversationReply[];
  needsInput: boolean;
  needsInputRequest: WorkspaceInlineActionRequest | null;
  latestTs: string;
  handoffs: HandoffItemRecord[];
};

type WorkspaceCoordinationQueueItem = {
  id: string;
  agentId: string;
  agentTitle: string;
  ts: string;
  kind: "needs_input" | "approval" | "handoff_follow_up";
  content: string;
  detail?: string;
  approval?: ApprovalRequestRecord;
  handoff?: HandoffItemRecord;
};

type WorkspaceTeamAsk = {
  id: string;
  title: string;
  summary: string;
  detail?: string;
  agentIds: string[];
  requestIds: string[];
  blockedBranches: Array<{ agentId: string; agentTitle: string; blockedSince: string; blockedReason: string }>;
  recommendedResponseShape: "approval" | "input" | "direction" | "confirmation";
  ts: string;
  /** True when the summary was produced by the batch LLM synthesis step. */
  synthesized?: boolean;
};

type WorkspacePromptGroup = {
  prompt: WorkspaceThreadEntry;
  targetCount: number;
  agentThreads: WorkspaceAgentThread[];
  coordinationQueue: WorkspaceCoordinationQueueItem[];
  coordinationFindings: Array<{
    id: string;
    findingType: string;
    agentTitle: string;
    summary: string;
    detail?: string;
    ts: string;
  }>;
  teamAsk: WorkspaceTeamAsk | null;
  pendingAgentTitles: string[];
};

type PlannerThreadEntry =
  | {
      id: string;
      ts: string;
      role: "user";
      provider: "codex" | "claude";
      model: string;
      task: string;
      constraints?: string;
    }
  | {
      id: string;
      ts: string;
      role: "assistant";
      source: "live" | "saved";
      suggestion: TaskPlanningSuggestion;
    };

type SavedPlannerRecommendationRecord = {
  savedAt: string;
  workspaceId: string;
  task: string;
  constraints?: string;
  suggestion: TaskPlanningSuggestion;
};

type CommandPaletteAction = {
  id: string;
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
};

const filters: Array<{ id: FilterId; label: string }> = [
  { id: "all", label: "All agents" },
  { id: "active", label: "Active" },
  { id: "idle", label: "Idle" },
  { id: "errors", label: "Errors" },
];

const menuItems: Array<{ id: MenuId; label: string }> = [{ id: "settings", label: "Settings" }];

function defaultModelForProvider(provider: "codex" | "claude"): string {
  return provider === "codex" ? "gpt-5-codex" : "sonnet";
}

/** Approximate context window sizes for known models. Used to show context budget %. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-haiku-4-5": 200_000,
  "gpt-5-codex": 32_000,
  "gpt-5.2-codex": 32_000,
  "gpt-4.1": 128_000,
  "gpt-4.1-mini": 128_000,
};

function getModelContextWindow(model: string): number {
  const key = model.trim().toLowerCase();
  if (MODEL_CONTEXT_WINDOWS[key]) return MODEL_CONTEXT_WINDOWS[key];
  for (const [k, v] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (key.includes(k) || key.startsWith(k.split("-").slice(0, 3).join("-"))) return v;
  }
  return 32_000;
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderInlineRichText(text: string): ReactNode[] {
  const parts = text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\))/g)
    .filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={`inline-code-${index}`} className="thread-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }

    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`inline-strong-${index}`}>{part.slice(2, -2)}</strong>;
    }

    const linkMatch = part.match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)]+)\)$/);
    if (linkMatch) {
      const [, label, href] = linkMatch;
      const resolvedHref = href.startsWith("/") ? `file://${href}` : href;
      return (
        <a
          key={`inline-link-${index}`}
          className="thread-inline-link"
          href={resolvedHref}
          rel="noreferrer"
          target="_blank"
        >
          {label}
        </a>
      );
    }

    return <span key={`inline-text-${index}`}>{part}</span>;
  });
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTable(lines: string[]): boolean {
  if (lines.length < 2) {
    return false;
  }

  if (!lines.every((line) => line.includes("|"))) {
    return false;
  }

  const separatorCells = parseMarkdownTableRow(lines[1]);
  return separatorCells.length > 0 && separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderMarkdownBlocks(content: string): JSX.Element[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const fencedSections = normalized.split(/```/);

  return fencedSections.flatMap((section, sectionIndex) => {
    if (sectionIndex % 2 === 1) {
      const codeBlock = section.replace(/^\w+\n/, "").trimEnd();
      return [
        <pre key={`code-${sectionIndex}`} className="file-preview-code thread-code-block">
          <code>{codeBlock}</code>
        </pre>,
      ];
    }

    return section
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block, blockIndex) => {
        const lines = block.split("\n");
        const key = `block-${sectionIndex}-${blockIndex}`;
        const heading = lines.length === 1 ? lines[0].match(/^(#{1,3})\s+(.*)$/) : null;
        if (heading) {
          const level = heading[1].length;
          const Tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
          return <Tag key={key}>{heading[2]}</Tag>;
        }

        if (lines.every((line) => /^>\s?/.test(line))) {
          return (
            <blockquote key={key} className="thread-blockquote">
              {lines.map((line, lineIndex) => (
                <p key={`${key}-quote-${lineIndex}`}>{renderInlineRichText(line.replace(/^>\s?/, ""))}</p>
              ))}
            </blockquote>
          );
        }

        const unordered = lines.every((line) => /^[-*]\s+/.test(line));
        if (unordered) {
          return (
            <ul key={key} className="thread-list">
              {lines.map((line, lineIndex) => (
                <li key={`${key}-li-${lineIndex}`}>{renderInlineRichText(line.replace(/^[-*]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }

        const ordered = lines.every((line) => /^\d+\.\s+/.test(line));
        if (ordered) {
          return (
            <ol key={key} className="thread-list">
              {lines.map((line, lineIndex) => (
                <li key={`${key}-ol-${lineIndex}`}>{renderInlineRichText(line.replace(/^\d+\.\s+/, ""))}</li>
              ))}
            </ol>
          );
        }

        if (isMarkdownTable(lines)) {
          const headerCells = parseMarkdownTableRow(lines[0]);
          const bodyRows = lines.slice(2).map(parseMarkdownTableRow);

          return (
            <div key={key} className="thread-table-wrap">
              <table className="thread-table">
                <thead>
                  <tr>
                    {headerCells.map((cell, cellIndex) => (
                      <th key={`${key}-head-${cellIndex}`}>{renderInlineRichText(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bodyRows.map((row, rowIndex) => (
                    <tr key={`${key}-row-${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`${key}-cell-${rowIndex}-${cellIndex}`}>{renderInlineRichText(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <p key={key}>
            {lines.map((line, lineIndex) => (
              <span key={`${key}-line-${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {renderInlineRichText(line)}
              </span>
            ))}
          </p>
        );
      });
  });
}

function renderPatchPreview(content: string): JSX.Element {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const visibleLines = lines.slice(0, 160);
  const truncated = visibleLines.length < lines.length;

  return (
    <div className="diff-preview" role="presentation">
      {visibleLines.map((line, index) => {
        let className = "diff-line diff-line-context";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          className = "diff-line diff-line-added";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          className = "diff-line diff-line-removed";
        } else if (
          line.startsWith("@@") ||
          line.startsWith("diff --git") ||
          line.startsWith("index ") ||
          line.startsWith("---") ||
          line.startsWith("+++")
        ) {
          className = "diff-line diff-line-meta";
        }

        return (
          <div key={`diff-${index}`} className={className}>
            <span className="diff-line-number">{index + 1}</span>
            <code>{line || " "}</code>
          </div>
        );
      })}
      {truncated ? <div className="diff-preview-footer">Preview truncated to the first 160 lines.</div> : null}
    </div>
  );
}

function renderArtifactPreview(kind: ArtifactRecord["kind"], content: string, truncated: boolean): JSX.Element {
  if (kind === "patch") {
    return renderPatchPreview(content);
  }

  const normalized = content.trim();
  let previewContent = normalized;

  if (kind === "trace") {
    try {
      previewContent = JSON.stringify(JSON.parse(normalized), null, 2);
    } catch {
      previewContent = normalized;
    }
  }

  return (
    <div className="artifact-preview-inline">
      <pre className="file-preview-code artifact-preview-log">{previewContent || "Artifact was empty."}</pre>
      {truncated ? <div className="diff-preview-footer">Preview truncated by the desktop reader.</div> : null}
    </div>
  );
}

function getAgentPreview(agent: AgentSessionRecord): string {
  return typeof agent.metadata.preview === "string"
    ? agent.metadata.preview
    : "No event output yet. Launch a demo or attach a live provider runner.";
}

function getAgentDescription(agent: AgentSessionRecord): string {
  if (typeof agent.metadata.initialTask === "string" && agent.metadata.initialTask.trim().length > 0) {
    return agent.metadata.initialTask;
  }

  return getAgentPreview(agent);
}

function getAgentMonitor(agent: AgentSessionRecord): string {
  return typeof agent.metadata.monitor === "string" ? agent.metadata.monitor : "Unassigned";
}

function buildOpsPulse(agents: AgentSessionRecord[]): string {
  const errorCount = agents.filter((agent) => agent.state === "ERROR").length;
  const idleCount = agents.filter((agent) => agent.state === "IDLE").length;
  const waitingCount = agents.filter((agent) => agent.state === "WAITING_INPUT").length;
  const approvalCount = agents.filter((agent) => agent.state === "WAITING_APPROVAL").length;

  if (agents.length === 0) {
    return "No agents running yet.";
  }

  if (errorCount === 0 && idleCount === 0 && waitingCount === 0 && approvalCount === 0) {
    return "No agents currently need attention.";
  }

  return `${errorCount} errors, ${idleCount} idle, ${waitingCount} waiting, ${approvalCount} approvals.`;
}

function buildOpsPulseCompact(agents: AgentSessionRecord[]): string {
  const errorCount = agents.filter((agent) => agent.state === "ERROR").length;
  const idleCount = agents.filter((agent) => agent.state === "IDLE").length;
  const waitingCount = agents.filter((agent) => agent.state === "WAITING_INPUT").length;
  const approvalCount = agents.filter((agent) => agent.state === "WAITING_APPROVAL").length;

  if (agents.length === 0) {
    return "No runs";
  }

  const parts: string[] = [];
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
  }
  if (approvalCount > 0) {
    parts.push(`${approvalCount} approval${approvalCount === 1 ? "" : "s"}`);
  }
  if (waitingCount > 0) {
    parts.push(`${waitingCount} waiting`);
  }
  if (idleCount > 0) {
    parts.push(`${idleCount} idle`);
  }

  return parts.length > 0 ? parts.join(" · ") : "Calm";
}

function getAttentionFilter(agents: AgentSessionRecord[]): FilterId {
  if (agents.some((agent) => agent.state === "ERROR")) {
    return "errors";
  }

  if (agents.some((agent) => agent.state === "WAITING_APPROVAL")) {
    return "active";
  }

  if (agents.some((agent) => agent.state === "IDLE")) {
    return "idle";
  }

  if (agents.some((agent) => agent.state === "WAITING_INPUT" || agent.state === "RUNNING")) {
    return "active";
  }

  return "all";
}

function getFleetActivityToneFromEvent(event: AgentEventRecord): FleetActivityTone {
  switch (event.type) {
    case "ERROR":
      return "danger";
    case "SESSION_COMPLETED":
      return "success";
    case "TOOL_CALL_STARTED":
      return "warning";
    case "TOOL_CALL_FINISHED":
      return "info";
    case "CONTEXT_DROPPED":
      return "warning";
    case "STATUS_CHANGED": {
      const payload = event.payload as { to?: keyof typeof agentStateMeta };
      return payload.to ? agentStateMeta[payload.to].tone : "info";
    }
    default:
      return "info";
  }
}

function summarizeAgentSnapshot(agent: AgentSessionRecord): {
  summary: string;
  detail: string;
  tone: FleetActivityTone;
} {
  const meta = agentStateMeta[agent.state];

  if (agent.state === "WAITING_APPROVAL") {
    return {
      summary: "Approval needed",
      detail: getAgentPreview(agent),
      tone: "warning",
    };
  }

  if (agent.state === "RUNNING" || agent.state === "STARTING" || agent.state === "WAITING_INPUT") {
    return {
      summary: meta.label,
      detail: getAgentPreview(agent),
      tone: meta.tone,
    };
  }

  if (agent.state === "ERROR") {
    return {
      summary: "Run error",
      detail: "The agent entered an error state. Open the agent thread to inspect the run transcript and exact failure.",
      tone: "danger",
    };
  }

  return {
    summary: meta.label,
    detail: getAgentPreview(agent),
    tone: meta.tone,
  };
}

function shouldShowFleetActivityEvent(event: AgentEventRecord): boolean {
  return event.type !== "HEARTBEAT";
}

function isFleetOutputEventType(type: AgentEventRecord["type"] | undefined): type is "OUTPUT_DELTA" | "OUTPUT_FINAL" {
  return type === "OUTPUT_DELTA" || type === "OUTPUT_FINAL";
}

function getFleetOutputText(event: AgentEventRecord): string | undefined {
  if (!isFleetOutputEventType(event.type)) {
    return undefined;
  }

  const payload = event.payload as { text?: string };
  return typeof payload.text === "string" ? payload.text : undefined;
}

function normalizeFleetOutputText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
}

function formatFleetOutputSummary(text: string): string {
  const normalized = normalizeFleetOutputText(text);
  return normalized.length > 0 ? truncateText(normalized, 320) : "Output received.";
}

function compareFleetActivityOrder(left: FleetActivityItem, right: FleetActivityItem): number {
  const tsDiff = Date.parse(left.ts) - Date.parse(right.ts);
  if (tsDiff !== 0) {
    return tsDiff;
  }

  if (typeof left.seq === "number" && typeof right.seq === "number" && left.seq !== right.seq) {
    return left.seq - right.seq;
  }

  return left.id.localeCompare(right.id);
}

function collapseFleetActivity(items: FleetActivityItem[], limit = 48): FleetActivityItem[] {
  const deduped = new Map<string, FleetActivityItem>();

  for (const item of items) {
    const current = deduped.get(item.id);
    if (!current || compareFleetActivityOrder(current, item) <= 0) {
      deduped.set(item.id, { ...item });
    }
  }

  const ordered = [...deduped.values()].sort(compareFleetActivityOrder);
  const collapsed: FleetActivityItem[] = [];
  const openOutputByAgent = new Map<string, FleetActivityItem>();

  for (const item of ordered) {
    if (isFleetOutputEventType(item.eventType)) {
      const rawText = item.rawText ?? item.summary;
      const existing = openOutputByAgent.get(item.agentId);

      if (existing) {
        const nextRawText = `${existing.rawText ?? existing.summary}${rawText}`;
        existing.rawText = nextRawText;
        existing.summary = formatFleetOutputSummary(nextRawText);
        existing.detail = undefined;
        existing.ts = item.ts;
        existing.seq = item.seq;
        existing.id = item.id;
        existing.eventType = item.eventType;
      } else {
        const nextItem: FleetActivityItem = {
          ...item,
          rawText,
          summary: formatFleetOutputSummary(rawText),
          detail: undefined,
        };
        collapsed.push(nextItem);
        openOutputByAgent.set(item.agentId, nextItem);
      }

      if (item.eventType === "OUTPUT_FINAL") {
        openOutputByAgent.delete(item.agentId);
      }
      continue;
    }

    openOutputByAgent.delete(item.agentId);
    collapsed.push({ ...item });
  }

  return collapsed
    .sort((left, right) => compareFleetActivityOrder(right, left))
    .slice(0, limit);
}

function isPrimaryWorkspaceConversationActivity(item: FleetActivityItem): boolean {
  return isFleetOutputEventType(item.eventType);
}

function isWorkspaceConversationReplyActivity(item: FleetActivityItem): boolean {
  return isFleetOutputEventType(item.eventType) || item.tone === "danger";
}

function getWorkspaceActivityMessageClass(item: FleetActivityItem): string {
  if (item.tone === "danger") {
    return "thread-message-danger";
  }

  if (item.tone === "warning") {
    return "thread-message-warning";
  }

  if (item.tone === "success") {
    return "thread-message-success";
  }

  return "thread-message-assistant";
}

function createFleetActivityFromEvent(
  event: AgentEventRecord,
  agentTitle: string,
): FleetActivityItem | null {
  if (!shouldShowFleetActivityEvent(event)) {
    return null;
  }

  return {
    id: event.eventId,
    agentId: event.agentId,
    agentTitle,
    ts: event.ts,
    summary: isFleetOutputEventType(event.type)
      ? formatFleetOutputSummary(getFleetOutputText(event) ?? "")
      : summarizeEvent(event),
    detail: isFleetOutputEventType(event.type) ? undefined : getEventPayloadPreview(event) ?? undefined,
    tone: getFleetActivityToneFromEvent(event),
    source: "event",
    eventType: event.type,
    seq: event.seq,
    rawText: getFleetOutputText(event),
  };
}

function extractConversationMessageFromActivityDetail(detail?: string): string | null {
  if (!detail) {
    return null;
  }

  try {
    const parsed = JSON.parse(detail) as { message?: unknown; reason?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }
    if (typeof parsed.reason === "string" && parsed.reason.trim().length > 0) {
      return parsed.reason.trim();
    }
  } catch {
    return null;
  }

  return null;
}

function buildConversationFallbackFromActivity(item: FleetActivityItem): {
  content: string;
  detail?: string;
} {
  const message = extractConversationMessageFromActivityDetail(item.detail);
  if (message) {
    return {
      content: message,
      detail: item.summary !== message ? item.summary : undefined,
    };
  }

  if (item.detail && item.detail.trim().length > 0 && item.detail !== item.summary) {
    return {
      content: item.summary,
      detail: item.detail,
    };
  }

  return { content: item.summary };
}

function extractActionRequestFromText(text?: string): string | null {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) {
    return null;
  }

  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const lineCandidates = [...lines].reverse();
  for (const line of lineCandidates) {
    if (/\?$/.test(line)) {
      return line;
    }
    if (
      /^(would you like|should i|please confirm|confirm|let me know|if you'd like|if you want|tell me which|choose|pick|reply with)/i.test(
        line,
      )
    ) {
      return line;
    }
  }

  const sentenceCandidates = normalized
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .reverse();

  for (const sentence of sentenceCandidates) {
    if (/\?$/.test(sentence)) {
      return sentence;
    }
    if (
      /^(would you like|should i|please confirm|confirm|let me know|if you'd like|if you want|tell me which|choose|pick|reply with)/i.test(
        sentence,
      )
    ) {
      return sentence;
    }
  }

  return null;
}

/**
 * When no explicit question is detected, extract the last meaningful statement from the
 * agent's output to give the operator a sense of where the agent stopped.
 * Skips code blocks and bullet lists which are data, not status.
 */
function extractLastStatement(text?: string): string | null {
  const normalized = (text ?? "").replace(/\r/g, "").trim();
  if (!normalized) return null;

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const para = paragraphs[i]!;
    // Skip code blocks, bullet lists, and numbered lists — they're data, not status.
    if (para.startsWith("```") || para.startsWith("- ") || /^\d+\./.test(para)) continue;
    if (para.length > 20) {
      return para.length > 160 ? `${para.slice(0, 157)}…` : para;
    }
  }
  return null;
}

function getWorkspaceActionRequestCopy(
  agentTitle: string,
  latestReply: WorkspaceConversationReply | null,
  explicitAsk: WorkspaceConversationReply | null,
): { content: string; detail: string } {
  const explicitContent = explicitAsk?.content?.trim();
  const explicitDetail = explicitAsk?.detail?.trim();
  if (explicitContent) {
    return {
      content: explicitContent,
      detail: explicitDetail || "Reply inline below to continue this branch without leaving Workspace.",
    };
  }

  const extractedAsk = extractActionRequestFromText(latestReply?.content);
  if (extractedAsk) {
    return {
      content: extractedAsk,
      detail: "Reply inline below to continue this branch without leaving Workspace.",
    };
  }

  // Use the last meaningful statement so the operator knows where the agent stopped,
  // even when no explicit question was found.
  const lastStatement = extractLastStatement(latestReply?.content);
  if (lastStatement) {
    return {
      content: lastStatement,
      detail: "Reply inline below to continue this branch without leaving Workspace.",
    };
  }

  return {
    content: `${agentTitle} has paused and is waiting for your next instruction.`,
    detail: "Reply inline below to continue this branch without leaving Workspace.",
  };
}

function formatWorkspaceFindingTypeLabel(value: string): string {
  switch (value) {
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
    case "general":
    default:
      return "General";
  }
}

function normalizeWorkspaceLabel(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildAgentExecutionOrder(
  agents: AgentSessionRecord[],
  coordinationState: CoordinationStateRecord | null | undefined,
): Map<string, number> {
  const order = new Map<string, number>();
  const briefAgents = coordinationState?.brief?.agents ?? [];

  if (briefAgents.length === 0) {
    return order;
  }

  for (const agent of agents) {
    const normalizedTitle = normalizeWorkspaceLabel(agent.title);
    const normalizedRole =
      typeof agent.metadata.role === "string" ? normalizeWorkspaceLabel(agent.metadata.role) : "";
    const executionOrderFromBrief = coordinationState?.agentBriefs.find(
      (briefEntry: CoordinationStateRecord["agentBriefs"][number]) => briefEntry.agentId === agent.id,
    )?.executionOrder;

    if (typeof executionOrderFromBrief === "number") {
      order.set(agent.id, executionOrderFromBrief);
      continue;
    }

    const recommendationIndex = briefAgents.findIndex((recommendation: CoordinationBriefRecord["agents"][number]) => {
      const normalizedRecommendationRole = normalizeWorkspaceLabel(recommendation.role);
      return (
        normalizedRecommendationRole === normalizedTitle ||
        normalizedRecommendationRole === normalizedRole ||
        normalizedRecommendationRole.includes(normalizedTitle) ||
        normalizedTitle.includes(normalizedRecommendationRole) ||
        normalizedRecommendationRole.includes(normalizedRole) ||
        normalizedRole.includes(normalizedRecommendationRole)
      );
    });

    if (recommendationIndex >= 0) {
      order.set(agent.id, recommendationIndex);
    }
  }

  return order;
}

function sortAgentsByExecutionOrder(
  agents: AgentSessionRecord[],
  executionOrderByAgentId: Map<string, number>,
): AgentSessionRecord[] {
  return [...agents].sort((left, right) => {
    const leftOrder = executionOrderByAgentId.get(left.id);
    const rightOrder = executionOrderByAgentId.get(right.id);

    if (typeof leftOrder === "number" && typeof rightOrder === "number" && leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    if (typeof leftOrder === "number") {
      return -1;
    }

    if (typeof rightOrder === "number") {
      return 1;
    }

    return left.title.localeCompare(right.title);
  });
}

function formatEventTimestamp(ts: string): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(ts: string): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function summarizeEvent(event: AgentEventRecord): string {
  switch (event.type) {
    case "OUTPUT_DELTA":
    case "OUTPUT_FINAL": {
      const payload = event.payload as { text?: string };
      return typeof payload.text === "string" ? payload.text : "Output received.";
    }
    case "ERROR": {
      const payload = event.payload as { message?: string };
      return typeof payload.message === "string" ? payload.message : "Agent error recorded.";
    }
    case "STATUS_CHANGED": {
      const payload = event.payload as { reason?: string; to?: string };
      return typeof payload.reason === "string"
        ? payload.reason
        : `State changed to ${String(payload.to ?? "unknown")}.`;
    }
    case "SESSION_STARTED":
      return "Session started.";
    case "SESSION_COMPLETED": {
      const payload = event.payload as { outcome?: string };
      return `Session ${String(payload.outcome ?? "completed")}.`;
    }
    case "TOOL_CALL_STARTED": {
      const payload = event.payload as { toolName?: string };
      return `Started tool call${payload.toolName ? `: ${payload.toolName}` : "."}`;
    }
    case "TOOL_CALL_FINISHED": {
      const payload = event.payload as { toolName?: string; success?: boolean };
      return `${payload.success === false ? "Failed" : "Finished"} tool call${
        payload.toolName ? `: ${payload.toolName}` : "."
      }`;
    }
    case "USAGE_TICK": {
      const payload = event.payload as { inputTokens?: number; outputTokens?: number };
      return `${Number(payload.inputTokens ?? 0).toLocaleString()} in / ${Number(
        payload.outputTokens ?? 0,
      ).toLocaleString()} out`;
    }
    case "HEARTBEAT":
      return "Heartbeat received.";
    case "CONTEXT_DROPPED": {
      const payload = event.payload as { droppedIds?: string[]; utilizationPercent?: number };
      const count = payload.droppedIds?.length ?? 0;
      const pct = payload.utilizationPercent ?? 0;
      return `Context truncated — ${count} item${count === 1 ? "" : "s"} dropped (context at ${pct}% of limit)`;
    }
    default:
      return event.type;
  }
}

function getLatestOutput(events: AgentEventRecord[], agent: AgentSessionRecord | null): string {
  const outputEvent = [...events]
    .reverse()
    .find((event) => event.type === "OUTPUT_FINAL" || event.type === "OUTPUT_DELTA" || event.type === "ERROR");

  if (outputEvent) {
    return summarizeEvent(outputEvent);
  }

  return agent ? getAgentPreview(agent) : "Select an agent to inspect its latest output.";
}

function countContextItems(contexts: ContextPackRecord[]): number {
  return contexts.reduce((total, context) => total + context.items.length, 0);
}

function buildSavedPlannerBlock(record: SavedPlannerRecommendationRecord): string {
  return [
    "[ACC_PLANNER_RECOMMENDATION]",
    "```json",
    JSON.stringify(record, null, 2),
    "```",
    "[/ACC_PLANNER_RECOMMENDATION]",
  ].join("\n");
}

function parseSavedPlannerRecommendations(sharedContext: string): SavedPlannerRecommendationRecord[] {
  return [...sharedContext.matchAll(/\[ACC_PLANNER_RECOMMENDATION\]\s*```json\s*([\s\S]*?)```\s*\[\/ACC_PLANNER_RECOMMENDATION\]/g)]
    .map((match) => match[1])
    .filter((match): match is string => Boolean(match))
    .flatMap((match) => {
      try {
        return [JSON.parse(match) as SavedPlannerRecommendationRecord];
      } catch {
        return [];
      }
    });
}

function stripPlannerRecommendationBlocks(sharedContext: string): string {
  return sharedContext
    .replace(/\[ACC_PLANNER_RECOMMENDATION\]\s*```json\s*[\s\S]*?```\s*\[\/ACC_PLANNER_RECOMMENDATION\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildCoordinationBriefFromPlanner(input: {
  source: CoordinationBriefRecord["source"];
  task?: string;
  constraints?: string;
  suggestion: TaskPlanningSuggestion;
}): CoordinationBriefRecord {
  return {
    savedAt: new Date().toISOString(),
    source: input.source,
    task: input.task?.trim() || undefined,
    constraints: input.constraints?.trim() || undefined,
    advisorProvider: input.suggestion.advisorProvider,
    advisorModel: input.suggestion.advisorModel,
    summary: input.suggestion.summary.trim(),
    coordinationNotes: input.suggestion.coordinationNotes.filter(Boolean),
    risks: input.suggestion.risks.filter(Boolean),
    agents: input.suggestion.agents,
  };
}

function buildCoordinationBriefFromSavedRecommendation(
  record: SavedPlannerRecommendationRecord,
): CoordinationBriefRecord {
  return buildCoordinationBriefFromPlanner({
    source: "saved_recommendation",
    task: record.task,
    constraints: record.constraints,
    suggestion: record.suggestion,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatJsonPreview(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateText(value: string, maxLength = 220): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicateLike(primary?: string, secondary?: string): boolean {
  if (!primary || !secondary) {
    return false;
  }

  const left = normalizeComparableText(primary);
  const right = normalizeComparableText(secondary);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length < 48) {
    return longer.includes(shorter);
  }

  return longer.includes(shorter.slice(0, Math.min(shorter.length, 180)));
}

function shouldCollapseWorkspaceReply(reply: WorkspaceConversationReply): boolean {
  const body = `${reply.content}\n${reply.detail ?? ""}`.trim();
  const lineCount = body.split("\n").length;
  return body.length > 340 || lineCount > 8;
}

function getTranscriptTone(event: AgentEventRecord): "assistant" | "tool" | "system" | "error" {
  if (event.type === "ERROR") {
    return "error";
  }

  if (event.type === "TOOL_CALL_STARTED" || event.type === "TOOL_CALL_FINISHED") {
    return "tool";
  }

  if (event.type === "OUTPUT_DELTA" || event.type === "OUTPUT_FINAL") {
    return "assistant";
  }

  return "system";
}

function getEventPayloadPreview(event: AgentEventRecord): string | null {
  if (event.type === "OUTPUT_DELTA" || event.type === "OUTPUT_FINAL") {
    const payload = event.payload as { text?: string };
    return typeof payload.text === "string" ? payload.text : null;
  }

  if (
    event.type === "USAGE_TICK" ||
    event.type === "TOOL_CALL_STARTED" ||
    event.type === "TOOL_CALL_FINISHED" ||
    event.type === "STATUS_CHANGED" ||
    event.type === "ERROR"
  ) {
    return formatJsonPreview(event.payload);
  }

  if (event.type === "CONTEXT_DROPPED") {
    const payload = event.payload as { droppedIds?: string[]; droppedChars?: number; limitChars?: number };
    const ids = (payload.droppedIds ?? []).map((id) => id.split(":").pop() ?? id);
    const chars = Number(payload.droppedChars ?? 0).toLocaleString();
    const limit = Number(payload.limitChars ?? 0).toLocaleString();
    return `Dropped: ${ids.join(", ")} (${chars} chars removed, limit: ${limit} chars)`;
  }

  return null;
}

function normalizePathString(path: string): string {
  const trimmed = path.trim();

  if (!trimmed) {
    return "";
  }

  const isAbsolute = trimmed.startsWith("/");
  const segments: string[] = [];

  for (const segment of trimmed.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length > 0) {
        segments.pop();
      }
      continue;
    }

    segments.push(segment);
  }

  if (!isAbsolute) {
    return segments.join("/");
  }

  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

function joinPath(base: string, next: string): string {
  const normalizedBase = normalizePathString(base || "/");
  return normalizePathString(`${normalizedBase === "/" ? "" : normalizedBase}/${next}`);
}

function getParentPath(path: string): string {
  const normalized = normalizePathString(path);

  if (!normalized || normalized === "/") {
    return normalized || "/";
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "/";
  }

  return `/${segments.slice(0, -1).join("/")}`;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizePathString(root);
  const normalizedTarget = normalizePathString(target);

  if (!normalizedRoot || !normalizedTarget) {
    return false;
  }

  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function findFirstFile(nodes: FileTreeNodeRecord[]): FileTreeNodeRecord | null {
  for (const node of nodes) {
    if (node.kind === "file") {
      return node;
    }

    if (node.children && node.children.length > 0) {
      const childMatch = findFirstFile(node.children);

      if (childMatch) {
        return childMatch;
      }
    }
  }

  return null;
}

function sortFileTreeNodes(nodes: FileTreeNodeRecord[]): FileTreeNodeRecord[] {
  return [...nodes]
    .map((node) => ({
      ...node,
      children: node.children ? sortFileTreeNodes(node.children) : undefined,
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }

      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
}

function flattenFileTree(nodes: FileTreeNodeRecord[]): FileTreeNodeRecord[] {
  const flattened: FileTreeNodeRecord[] = [];

  for (const node of nodes) {
    flattened.push(node);

    if (node.children && node.children.length > 0) {
      flattened.push(...flattenFileTree(node.children));
    }
  }

  return flattened;
}

function getRelativePath(root: string, target: string): string {
  const normalizedRoot = normalizePathString(root);
  const normalizedTarget = normalizePathString(target);

  if (!normalizedRoot || !normalizedTarget) {
    return "";
  }

  if (normalizedRoot === normalizedTarget) {
    return ".";
  }

  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1);
  }

  return normalizedTarget;
}

function findFirstVisibleFile(nodes: FileTreeNodeRecord[]): FileTreeNodeRecord | null {
  return nodes.find((node) => node.kind === "file") ?? null;
}

function getPathLeaf(path: string): string {
  const trimmed = normalizePathString(path);
  if (!trimmed) {
    return "";
  }

  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

function isNodeMatch(node: FileTreeNodeRecord, searchTerm: string, root: string): boolean {
  const haystack = `${node.name} ${getRelativePath(root, node.path)}`.toLowerCase();
  return haystack.includes(searchTerm);
}

export function App() {
  const queryClient = useQueryClient();
  const settingsAvailable = isTauriRuntime();

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("acc-theme");
    return saved === "dark" ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("acc-theme", theme);
  }, [theme]);

  // Zoom: stored as a number 0.5–2.0, default 1.0
  const [zoom, setZoom] = useState<number>(() => {
    const saved = localStorage.getItem("acc-zoom");
    const parsed = saved ? parseFloat(saved) : 1;
    return Number.isFinite(parsed) ? Math.min(2, Math.max(0.5, parsed)) : 1;
  });
  useEffect(() => {
    document.documentElement.style.setProperty("zoom", String(zoom));
    localStorage.setItem("acc-zoom", String(zoom));
  }, [zoom]);
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10));
      } else if (e.key === "-") {
        e.preventDefault();
        setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const commandPaletteInputRef = useRef<HTMLInputElement | null>(null);
  const agentTitleLookupRef = useRef<Map<string, string>>(new Map());
  const previousAgentSnapshotsRef = useRef<Map<string, { state: AgentSessionRecord["state"]; lastEventAt: string; preview: string }>>(
    new Map(),
  );

  const [filter, setFilter] = useState<FilterId>("all");
  const [activeMenu, setActiveMenu] = useState<MenuId | null>(null);
  const [homeThread, setHomeThread] = useState<HomeThread>({ kind: "workspace" });
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("session");
  const [rightSidebarTab, setRightSidebarTab] = useState<RightSidebarTab>("files");
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
  const [settingsDrawerTab, setSettingsDrawerTab] = useState<SettingsDrawerTab>("providers");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [newWorkspaceDraft, setNewWorkspaceDraft] = useState("Agent Command Center");
  const [newWorkspaceProjectRootDraft, setNewWorkspaceProjectRootDraft] = useState("");
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [workspaceProjectRootDraft, setWorkspaceProjectRootDraft] = useState("");
  const [sharedContextDraft, setSharedContextDraft] = useState("");
  const [streamConnected, setStreamConnected] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [coordinationApiKey, setCoordinationApiKey] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [workspaceFocusedAgentId, setWorkspaceFocusedAgentId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [agentTitleDraft, setAgentTitleDraft] = useState("");
  const [agentWorkingDirectoryDraft, setAgentWorkingDirectoryDraft] = useState("");
  const [selectedProjectFiles, setSelectedProjectFiles] = useState<string[]>([]);
  const [agentProviderDraft, setAgentProviderDraft] = useState<"codex" | "claude">("codex");
  const [agentModelDraft, setAgentModelDraft] = useState(defaultModelForProvider("codex"));
  const [plannerProviderDraft, setPlannerProviderDraft] = useState<"codex" | "claude">("codex");
  const [plannerModelDraft, setPlannerModelDraft] = useState(defaultModelForProvider("codex"));
  const [plannerTaskDraft, setPlannerTaskDraft] = useState("");
  const [plannerConstraintsDraft, setPlannerConstraintsDraft] = useState("");
  const [plannerSuggestionState, setPlannerSuggestionState] = useState<TaskPlanningSuggestion | null>(null);
  const [activePlannerHistoryEntryId, setActivePlannerHistoryEntryId] = useState<string>("");
  const [plannerAgentDrafts, setPlannerAgentDrafts] = useState<
    Array<{ provider: "codex" | "claude"; model: string }>
  >([]);
  const [agentTitleCreateDraft, setAgentTitleCreateDraft] = useState("");
  const [agentRoleDraft, setAgentRoleDraft] = useState("");
  const [agentTaskDraft, setAgentTaskDraft] = useState("");
  const [agentCwdDraft, setAgentCwdDraft] = useState("");
  const [selectedContextPackIds, setSelectedContextPackIds] = useState<string[]>([]);
  const [agentFlowPending, setAgentFlowPending] = useState(false);
  const [plannerFleetPending, setPlannerFleetPending] = useState(false);
  const [plannerSavePending, setPlannerSavePending] = useState(false);
  const [agentInputDraft, setAgentInputDraft] = useState("");
  const [broadcastInputDraft, setBroadcastInputDraft] = useState("");
  const [inlineAgentReplyDrafts, setInlineAgentReplyDrafts] = useState<Record<string, string>>({});
  const [agentMessagePending, setAgentMessagePending] = useState(false);
  const [broadcastPending, setBroadcastPending] = useState(false);
  const [workspaceLiveFeedFilter, setWorkspaceLiveFeedFilter] = useState<"all" | "errors">("all");
  const [workspaceThreadTab, setWorkspaceThreadTab] = useState<"conversation" | "audit">("conversation");
  const [deleteWorkspaceArmed, setDeleteWorkspaceArmed] = useState(false);
  const [leftRailWidth, setLeftRailWidth] = useState(160);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [workspaceStopScope, setWorkspaceStopScope] = useState<"visible" | "all" | "running">("visible");
  const [workspaceSettingsPopoverOpen, setWorkspaceSettingsPopoverOpen] = useState(false);
  const [workspaceSettingsPopoverPosition, setWorkspaceSettingsPopoverPosition] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [dragState, setDragState] = useState<
    | { target: ResizeTarget; startX?: number; startWidth?: number }
    | null
  >(null);
  const [selectedExplorerFilePath, setSelectedExplorerFilePath] = useState("");
  const [openExplorerTabs, setOpenExplorerTabs] = useState<string[]>([]);
  const [explorerLocationDraft, setExplorerLocationDraft] = useState("");
  const [explorerRootOverride, setExplorerRootOverride] = useState("");
  const [explorerSearchDraft, setExplorerSearchDraft] = useState("");
  const [expandedExplorerPaths, setExpandedExplorerPaths] = useState<string[]>([]);
  const [selectedExplorerContent, setSelectedExplorerContent] = useState("");
  const [selectedExplorerLoadedContent, setSelectedExplorerLoadedContent] = useState("");
  const [selectedExplorerTruncated, setSelectedExplorerTruncated] = useState(false);
  const [artifactPreviewCache, setArtifactPreviewCache] = useState<
    Record<string, { content: string; truncated: boolean; error?: string }>
  >({});
  const [filePreviewPending, setFilePreviewPending] = useState(false);
  const [fileSavePending, setFileSavePending] = useState(false);
  const workspaceSettingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceConversationStreamRef = useRef<HTMLDivElement | null>(null);
  const workspaceShouldAutoScrollRef = useRef(true);
  const workspaceScrollHeightRef = useRef(0);
  // True while a programmatic scroll is in-flight — suppresses the scroll listener
  // so it doesn't incorrectly set workspaceShouldAutoScrollRef to false mid-animation.
  const workspaceIsProgrammaticScrollRef = useRef(false);
  const workspaceScrollListenerCleanupRef = useRef<(() => void) | null>(null);
  // Callback ref: attaches a scroll listener that tracks whether the user is near the bottom.
  // Programmatic scrolls are ignored (via workspaceIsProgrammaticScrollRef) so smooth-scroll
  // animations don't incorrectly mark the user as "scrolled away".
  const setWorkspaceConversationContainer = useCallback((node: HTMLDivElement | null) => {
    if (workspaceScrollListenerCleanupRef.current) {
      workspaceScrollListenerCleanupRef.current();
      workspaceScrollListenerCleanupRef.current = null;
    }
    workspaceConversationStreamRef.current = node;
    if (node) {
      const listener = () => {
        if (workspaceIsProgrammaticScrollRef.current) return;
        const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 300;
        workspaceShouldAutoScrollRef.current = nearBottom;
      };
      node.addEventListener("scroll", listener, { passive: true });
      workspaceScrollListenerCleanupRef.current = () => node.removeEventListener("scroll", listener);
    }
  }, []);
  const [terminalCommandDraft, setTerminalCommandDraft] = useState("");
  const [terminalPending, setTerminalPending] = useState(false);
  const [terminalHistory, setTerminalHistory] = useState<TerminalCommandResultRecord[]>([]);
  const [collapsedAgentActivityById, setCollapsedAgentActivityById] = useState<Record<string, boolean>>({});
  const [workspaceRosterExpanded, setWorkspaceRosterExpanded] = useState(false);
  const [findingsExpanded, setFindingsExpanded] = useState<Record<string, boolean>>({});
  const [expandedFindingCards, setExpandedFindingCards] = useState<Record<string, boolean>>({});
  const [expandedWorkspaceReplies, setExpandedWorkspaceReplies] = useState<Record<string, boolean>>({});
  const [workspaceNotice, setWorkspaceNotice] = useState<{
    tone: NoticeTone;
    text: string;
  } | null>(null);
  const [workspaceThreadEntries, setWorkspaceThreadEntries] = useState<WorkspaceThreadEntry[]>([]);
  const [plannerThreadEntries, setPlannerThreadEntries] = useState<PlannerThreadEntry[]>([]);
  const [fleetActivityFeed, setFleetActivityFeed] = useState<FleetActivityItem[]>([]);
  const [pendingRunRequests, setPendingRunRequests] = useState<Record<string, { ts: string; prompt: string; runId?: string }>>({});
  const [workspaceContextExpanded, setWorkspaceContextExpanded] = useState(false);
  const [usageBreakdownOpen, setUsageBreakdownOpen] = useState(false);

  useEffect(() => {
    if (!workspaceNotice) {
      return;
    }

    const dismissAfterMs = workspaceNotice.tone === "error" ? 8_000 : workspaceNotice.tone === "success" ? 4_500 : 3_500;
    const timeoutId = window.setTimeout(() => {
      setWorkspaceNotice((current) => (current === workspaceNotice ? null : current));
    }, dismissAfterMs);

    return () => window.clearTimeout(timeoutId);
  }, [workspaceNotice]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setWorkspaceThreadEntries([]);
      return;
    }

    try {
      const raw = window.localStorage.getItem(`acc.workspace-thread.v1:${activeWorkspaceId}`);
      if (!raw) {
        setWorkspaceThreadEntries([]);
        return;
      }

      const parsed = JSON.parse(raw) as WorkspaceThreadEntry[];
      setWorkspaceThreadEntries(Array.isArray(parsed) ? parsed : []);
    } catch {
      setWorkspaceThreadEntries([]);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }

    try {
      window.localStorage.setItem(
        `acc.workspace-thread.v1:${activeWorkspaceId}`,
        JSON.stringify(workspaceThreadEntries.slice(-80)),
      );
    } catch {
      // Ignore local storage persistence failures in the desktop shell.
    }
  }, [activeWorkspaceId, workspaceThreadEntries]);

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5_000,
  });

  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
    refetchInterval: 5_000,
  });

  const workspaceOverviewQuery = useQuery({
    queryKey: ["workspace-overview", activeWorkspaceId],
    queryFn: () => fetchWorkspaceOverview(activeWorkspaceId),
    enabled: activeWorkspaceId.length > 0,
    refetchInterval: 3_000,
  });

  const providerSettingsQuery = useQuery({
    queryKey: ["provider-settings"],
    queryFn: fetchProviderSettings,
  });

  const runtimeStatusQuery = useQuery({
    queryKey: ["control-plane-runtime-status"],
    queryFn: fetchControlPlaneRuntimeStatus,
    enabled: settingsAvailable,
    refetchInterval: 3_000,
  });

  const agentEventsQuery = useQuery({
    queryKey: ["agent-events", selectedAgentId],
    queryFn: () => fetchAgentEvents(selectedAgentId),
    enabled: selectedAgentId.length > 0,
    refetchInterval: 3_000,
  });

  const workspaceEventsQuery = useQuery({
    queryKey: ["workspace-events", activeWorkspaceId],
    queryFn: () => fetchWorkspaceEvents(activeWorkspaceId, { limit: 240 }),
    enabled: activeWorkspaceId.length > 0,
    refetchInterval: 3_000,
  });

  const agentRunsQuery = useQuery({
    queryKey: ["agent-runs", selectedAgentId],
    queryFn: () => fetchAgentRuns(selectedAgentId),
    enabled: selectedAgentId.length > 0,
    refetchInterval: 3_000,
  });

  const projectFilesQuery = useQuery({
    queryKey: ["workspace-project-files", activeWorkspaceId, workspaceOverviewQuery.data?.workspace.projectRoot ?? ""],
    queryFn: () => fetchProjectFiles(activeWorkspaceId),
    enabled:
      activeWorkspaceId.length > 0 &&
      Boolean(workspaceOverviewQuery.data?.workspace.projectRoot.trim().length),
    staleTime: 60_000,
  });

  const currentThreadKey = useMemo(() => {
    if (!activeWorkspaceId) {
      return "";
    }

    if (activeMenu === "settings") {
      return `settings:${activeWorkspaceId}`;
    }

    if (homeThread.kind === "agent") {
      return `agent:${activeWorkspaceId}:${homeThread.agentId ?? selectedAgentId ?? "none"}`;
    }

    return `${homeThread.kind}:${activeWorkspaceId}`;
  }, [activeMenu, activeWorkspaceId, homeThread, selectedAgentId]);
  const explorerScopedAgent =
    homeThread.kind === "agent"
      ? workspaceOverviewQuery.data?.agentsSummary.find((agent) => agent.id === (homeThread.agentId ?? selectedAgentId)) ?? null
      : homeThread.kind === "workspace" && workspaceFocusedAgentId
        ? workspaceOverviewQuery.data?.agentsSummary.find((agent) => agent.id === workspaceFocusedAgentId) ?? null
        : null;
  const workspaceDraftStorageKey = activeWorkspaceId ? `acc.thread-draft.workspace.v1:${activeWorkspaceId}` : "";
  const plannerDraftStorageKey = activeWorkspaceId ? `acc.thread-draft.planner.v1:${activeWorkspaceId}` : "";
  const agentDraftStorageKey =
    activeWorkspaceId && selectedAgentId ? `acc.thread-draft.agent.v1:${activeWorkspaceId}:${selectedAgentId}` : "";
  const explorerScopeKey = useMemo(() => {
    if (!activeWorkspaceId) {
      return "";
    }

    if (homeThread.kind === "agent") {
      return explorerScopedAgent ? `agent:${activeWorkspaceId}:${explorerScopedAgent.id}` : `agent:${activeWorkspaceId}:unselected`;
    }

    return `${homeThread.kind}:${activeWorkspaceId}`;
  }, [activeWorkspaceId, explorerScopedAgent, homeThread]);
  const defaultExplorerRoot =
    explorerScopedAgent?.worktree?.path ??
    (explorerScopedAgent?.metadata.cwd as string | undefined) ??
    workspaceOverviewQuery.data?.workspace.projectRoot ??
    "";
  const explorerBoundaryRoot = normalizePathString(defaultExplorerRoot);
  const explorerRoot = explorerRootOverride || defaultExplorerRoot;

  const projectTreeQuery = useQuery({
    queryKey: ["workspace-project-tree", explorerRoot],
    queryFn: () => fetchProjectTree(explorerRoot),
    enabled:
      settingsAvailable &&
      Boolean(explorerRoot) &&
      activeMenu === null,
    staleTime: 60_000,
  });

  const agentArtifactsQuery = useQuery({
    queryKey: ["agent-artifacts", selectedAgentId],
    queryFn: () => fetchAgentArtifacts(selectedAgentId),
    enabled: selectedAgentId.length > 0,
    refetchInterval: 5_000,
  });

  const selectedRunTranscriptQuery = useQuery({
    queryKey: ["run-transcript", selectedRunId],
    queryFn: () => fetchRunTranscript(selectedRunId),
    enabled: selectedRunId.length > 0,
    refetchInterval: 3_000,
  });

  const selectedRunToolCallsQuery = useQuery({
    queryKey: ["run-tool-calls", selectedRunId],
    queryFn: () => fetchRunToolCalls(selectedRunId),
    enabled: selectedRunId.length > 0,
    refetchInterval: 3_000,
  });

  const selectedRunArtifactsQuery = useQuery({
    queryKey: ["run-artifacts", selectedRunId],
    queryFn: () => fetchRunArtifacts(selectedRunId),
    enabled: selectedRunId.length > 0,
    refetchInterval: 5_000,
  });

  const pendingApprovalsQuery = useQuery({
    queryKey: ["pending-approvals", activeWorkspaceId],
    queryFn: () => fetchPendingApprovals(activeWorkspaceId),
    enabled: activeWorkspaceId.length > 0,
    refetchInterval: 3_000,
  });

  const inboxQuery = useQuery({
    queryKey: ["workspace-inbox", activeWorkspaceId],
    queryFn: () => fetchWorkspaceInbox(activeWorkspaceId),
    enabled: activeWorkspaceId.length > 0,
    refetchInterval: 3_000,
  });

  const createWorkspaceMutation = useMutation({
    mutationFn: createWorkspace,
  });

  const bootstrapDemoMutation = useMutation({
    mutationFn: bootstrapDemoWorkspace,
    onSuccess: async (_result, workspaceId) => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      await queryClient.refetchQueries({
        queryKey: ["workspace-overview", workspaceId],
        exact: true,
      });
    },
  });

  const providerSettingsMutation = useMutation({
    mutationFn: saveProviderSettings,
    onSuccess: async () => {
      setOpenaiApiKey("");
      setAnthropicApiKey("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["provider-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["control-plane-runtime-status"] }),
        queryClient.invalidateQueries({ queryKey: ["health"] }),
      ]);
    },
  });

  const renameWorkspaceMutation = useMutation({
    mutationFn: ({
      workspaceId,
      name,
      projectRoot,
    }: {
      workspaceId: string;
      name: string;
      projectRoot?: string;
    }) => updateWorkspace(workspaceId, { name, projectRoot }),
  });

  const deleteWorkspaceMutation = useMutation({
    mutationFn: deleteWorkspace,
  });

  const renameAgentMutation = useMutation({
    mutationFn: ({ agentId, title, cwd }: { agentId: string; title: string; cwd?: string }) =>
      updateAgent(agentId, { title, cwd }),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-events", variables.agentId] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-project-tree"] }),
      ]);
    },
  });

  const saveSharedContextMutation = useMutation({
    mutationFn: ({ workspaceId, sharedContext }: { workspaceId: string; sharedContext: string }) =>
      updateWorkspace(workspaceId, { sharedContext }),
  });

  const saveCoordinationBriefMutation = useMutation({
    mutationFn: ({
      workspaceId,
      coordinationBrief,
    }: {
      workspaceId: string;
      coordinationBrief: CoordinationBriefRecord | null;
    }) => updateWorkspaceCoordination(workspaceId, { brief: coordinationBrief }),
  });

  const importSharedContextMutation = useMutation({
    mutationFn: ({
      workspaceId,
      paths,
      mode,
    }: {
      workspaceId: string;
      paths: string[];
      mode: "append" | "replace";
    }) => importSharedContextFromProject(workspaceId, { paths, mode }),
  });

  const createAgentMutation = useMutation({
    mutationFn: createAgent,
  });

  const plannerSuggestionMutation = useMutation({
    mutationFn: fetchPlannerSuggestion,
  });

  const startSelectedAgentMutation = useMutation({
    mutationFn: startAgent,
  });

  const interruptSelectedAgentMutation = useMutation({
    mutationFn: interruptAgent,
  });

  const stopSelectedAgentMutation = useMutation({
    mutationFn: stopAgent,
  });

  const createRunMutation = useMutation({
    mutationFn: createAgentRun,
  });

  const stopRunMutation = useMutation({
    mutationFn: stopRun,
  });

  const approveApprovalMutation = useMutation({
    mutationFn: approveApproval,
  });

  const denyApprovalMutation = useMutation({
    mutationFn: denyApproval,
  });

  const resetWorktreeMutation = useMutation({
    mutationFn: resetAgentWorktree,
  });

  const createAgentFromHandoffMutation = useMutation({
    mutationFn: createAgentFromHandoff,
  });

  const assignHandoffMutation = useMutation({
    mutationFn: assignHandoff,
  });

  const updateHandoffStatusMutation = useMutation({
    mutationFn: updateHandoffStatus,
  });

  const dismissTeamAskMutation = useMutation({
    mutationFn: dismissTeamAsk,
    onSuccess: () => {
      void workspaceOverviewQuery.refetch();
    },
  });

  const overview = workspaceOverviewQuery.data;
  const agents = overview?.agentsSummary ?? [];
  const contexts = overview?.contextsSummary ?? [];
  const totalCost = overview?.usageSummary.totalCostUsd ?? 0;
  const totalTokens =
    (overview?.usageSummary.totalInputTokens ?? 0) + (overview?.usageSummary.totalOutputTokens ?? 0);
  const baseUrl = getControlPlaneBaseUrl();
  const workspaceData = activeWorkspaceId && overview ? overview : null;
  const hasWorkspace = Boolean(workspaceData);
  const providerSettings = providerSettingsQuery.data;
  const runtimeStatus = runtimeStatusQuery.data;
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const workspaceFocusedAgent = agents.find((agent) => agent.id === workspaceFocusedAgentId) ?? null;
  const agentRuns = agentRunsQuery.data ?? [];
  const selectedRun = agentRuns.find((run) => run.id === selectedRunId) ?? agentRuns[0] ?? null;
  const agentEvents = agentEventsQuery.data ?? [];
  const runTranscript = selectedRunTranscriptQuery.data ?? [];
  const runToolCalls = selectedRunToolCallsQuery.data ?? [];
  const runArtifacts = selectedRunArtifactsQuery.data ?? [];
  const pendingApprovals = pendingApprovalsQuery.data ?? [];
  const workspaceInbox = inboxQuery.data?.inbox ?? [];
  const selectedRunApprovals = selectedRun
    ? pendingApprovals.filter((approval) => approval.runId === selectedRun.id)
    : [];
  const runToolCallById = useMemo(
    () => new Map(runToolCalls.map((toolCall) => [toolCall.id, toolCall])),
    [runToolCalls],
  );
  const selectedRunConversation = selectedRun
    ? runTranscript.filter((entry) => ["user", "assistant", "system", "error"].includes(entry.entryType))
    : [];
  const selectedRunActivity = selectedRun
    ? runTranscript.filter((entry) => entry.entryType === "tool" || entry.entryType === "approval")
    : [];
  const selectedRunHandoffs = selectedRun
    ? workspaceInbox.filter((handoff) => handoff.sourceRunId === selectedRun.id)
    : [];
  const selectedRunPatchArtifacts = runArtifacts.filter((artifact) => artifact.kind === "patch");
  const selectedRunLogArtifacts = runArtifacts.filter((artifact) => artifact.kind === "log");
  const selectedRunFileArtifacts = runArtifacts.filter((artifact) => artifact.kind === "file");
  const selectedRunTraceArtifacts = runArtifacts.filter((artifact) => artifact.kind === "trace");
  const workspaceAgentRunsQueries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: ["agent-runs", agent.id],
      queryFn: () => fetchAgentRuns(agent.id),
      enabled: activeWorkspaceId.length > 0 && activeMenu === null && homeThread.kind === "workspace",
      refetchInterval: 3_000,
    })),
  });
  const workspaceAgentRunsByAgentId = useMemo(() => {
    const next = new Map<string, AgentRunRecord[]>();

    agents.forEach((agent, index) => {
      const runs = workspaceAgentRunsQueries[index]?.data ?? [];
      next.set(
        agent.id,
        [...runs].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)),
      );
    });

    return next;
  }, [agents, workspaceAgentRunsQueries]);
  const workspaceConversationRunIds = useMemo(() => {
    if (workspaceThreadEntries.length === 0) {
      return [];
    }

    const visiblePrompts = workspaceThreadEntries.filter((entry) =>
      workspaceFocusedAgent ? entry.scope !== "agent" || entry.agentId === workspaceFocusedAgent.id : true,
    );

    if (visiblePrompts.length === 0) {
      return [];
    }

    const earliestPromptMs = Math.min(...visiblePrompts.map((entry) => Date.parse(entry.ts)));
    const runIds: string[] = [];

    workspaceAgentRunsByAgentId.forEach((runs, agentId) => {
      if (workspaceFocusedAgent && agentId !== workspaceFocusedAgent.id) {
        return;
      }

      runs.forEach((run) => {
        const startedAtMs = Date.parse(run.startedAt || run.createdAt);
        if (Number.isFinite(startedAtMs) && startedAtMs >= earliestPromptMs) {
          runIds.push(run.id);
        }
      });
    });

    return [...new Set(runIds)].slice(-60);
  }, [workspaceAgentRunsByAgentId, workspaceFocusedAgent, workspaceThreadEntries]);
  const workspaceConversationTranscriptQueries = useQueries({
    queries: workspaceConversationRunIds.map((runId) => ({
      queryKey: ["run-transcript", runId],
      queryFn: () => fetchRunTranscript(runId),
      enabled: runId.length > 0 && activeMenu === null && homeThread.kind === "workspace",
      refetchInterval: 3_000,
    })),
  });
  const workspaceRunTranscriptByRunId = useMemo(() => {
    const next = new Map<string, TranscriptEntryRecord[]>();

    workspaceConversationRunIds.forEach((runId, index) => {
      next.set(
        runId,
        [...(workspaceConversationTranscriptQueries[index]?.data ?? [])].sort(
          (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
        ),
      );
    });

    return next;
  }, [workspaceConversationRunIds, workspaceConversationTranscriptQueries]);
  const latestRunPatchArtifact = selectedRunPatchArtifacts[0] ?? null;
  const selectedRunTelemetryEvents = useMemo(() => {
    if (!selectedRun) {
      return [];
    }

    const runStartedAtMs = Date.parse(selectedRun.startedAt);
    const runCompletedAtMs = selectedRun.completedAt ? Date.parse(selectedRun.completedAt) : Number.POSITIVE_INFINITY;

    return agentEvents.filter((event) => {
      const eventTsMs = Date.parse(event.ts);

      if (!Number.isFinite(eventTsMs)) {
        return false;
      }

      if (eventTsMs < runStartedAtMs || eventTsMs > runCompletedAtMs) {
        return false;
      }

      return [
        "STATUS_CHANGED",
        "OUTPUT_DELTA",
        "OUTPUT_FINAL",
        "TOOL_CALL_STARTED",
        "TOOL_CALL_FINISHED",
        "USAGE_TICK",
        "HEARTBEAT",
        "ERROR",
        "SESSION_COMPLETED",
      ].includes(event.type);
    });
  }, [agentEvents, selectedRun]);
  const selectedRunTelemetrySummary = useMemo(() => {
    const summary = {
      outputDeltas: 0,
      toolSteps: 0,
      usageTicks: 0,
      heartbeats: 0,
      errors: 0,
    };

    for (const event of selectedRunTelemetryEvents) {
      if (event.type === "OUTPUT_DELTA") {
        summary.outputDeltas += 1;
      }
      if (event.type === "TOOL_CALL_STARTED" || event.type === "TOOL_CALL_FINISHED") {
        summary.toolSteps += 1;
      }
      if (event.type === "USAGE_TICK") {
        summary.usageTicks += 1;
      }
      if (event.type === "HEARTBEAT") {
        summary.heartbeats += 1;
      }
      if (event.type === "ERROR") {
        summary.errors += 1;
      }
    }

    return summary;
  }, [selectedRunTelemetryEvents]);
  const selectedRunLiveText = useMemo(() => {
    const deltaText = selectedRunTelemetryEvents
      .filter((event) => event.type === "OUTPUT_DELTA")
      .map((event) => {
        const payload = event.payload as { text?: string };
        return typeof payload.text === "string" ? payload.text : "";
      })
      .join("");

    if (deltaText.trim().length > 0) {
      return deltaText.trim();
    }

    const finalOutputEvent = [...selectedRunTelemetryEvents]
      .reverse()
      .find((event) => event.type === "OUTPUT_FINAL");
    const payload = finalOutputEvent?.payload as { text?: string } | undefined;
    return typeof payload?.text === "string" ? payload.text : "";
  }, [selectedRunTelemetryEvents]);
  const selectedRunLatestUsageEvent = useMemo(
    () => [...selectedRunTelemetryEvents].reverse().find((event) => event.type === "USAGE_TICK") ?? null,
    [selectedRunTelemetryEvents],
  );
  const plannerSuggestion: TaskPlanningSuggestion | null = plannerSuggestionState;
  const plannerSuggestionWithDrafts = useMemo<TaskPlanningSuggestion | null>(() => {
    if (!plannerSuggestion) {
      return null;
    }

    return {
      ...plannerSuggestion,
      agents: plannerSuggestion.agents.map((recommendation, index) => {
        const draft = plannerAgentDrafts[index] ?? {
          provider: recommendation.provider,
          model: recommendation.model,
        };

        return {
          ...recommendation,
          provider: draft.provider,
          model: draft.model,
        };
      }),
    };
  }, [plannerAgentDrafts, plannerSuggestion]);
  const homeThreadLabel =
    homeThread.kind === "workspace"
      ? "Workspace"
      : homeThread.kind === "agent"
        ? "Agents"
      : homeThread.kind === "planner"
        ? "Planner"
        : homeThread.kind === "inbox"
          ? "Inbox"
          : "Agents";
  const activeMenuLabel =
    activeMenu === null ? homeThreadLabel : menuItems.find((item) => item.id === activeMenu)?.label ?? "Settings";
  const showContextRail =
    activeMenu === null && rightSidebarVisible && homeThread.kind !== "planner";
  const projectFileCandidates = projectFilesQuery.data?.candidates ?? [];
  const savedPlannerRecommendations = useMemo(
    () => parseSavedPlannerRecommendations(sharedContextDraft || workspaceData?.workspace.sharedContext || ""),
    [sharedContextDraft, workspaceData?.workspace.sharedContext],
  );
  const lastSavedPlannerRecommendation = savedPlannerRecommendations.at(-1) ?? null;
  const workspaceCoordinationState = workspaceData?.coordinationState ?? null;
  const persistedCoordinationBrief = workspaceData?.coordinationState?.brief ?? null;
  const draftCoordinationBrief = useMemo(
    () =>
      plannerSuggestionWithDrafts
        ? buildCoordinationBriefFromPlanner({
            source: "planner",
            task: plannerTaskDraft,
            constraints: plannerConstraintsDraft,
            suggestion: plannerSuggestionWithDrafts,
          })
        : null,
    [plannerConstraintsDraft, plannerSuggestionWithDrafts, plannerTaskDraft],
  );
  const savedCoordinationBrief = useMemo(
    () =>
      lastSavedPlannerRecommendation
        ? buildCoordinationBriefFromSavedRecommendation(lastSavedPlannerRecommendation)
        : null,
    [lastSavedPlannerRecommendation],
  );
  const activeCoordinationBrief = draftCoordinationBrief ?? persistedCoordinationBrief ?? savedCoordinationBrief;
  const agentExecutionOrderById = useMemo(
    () => buildAgentExecutionOrder(agents, workspaceCoordinationState),
    [agents, workspaceCoordinationState],
  );
  const orderedAgents = useMemo(
    () => sortAgentsByExecutionOrder(agents, agentExecutionOrderById),
    [agentExecutionOrderById, agents],
  );
  const cleanedSharedContext = useMemo(
    () => stripPlannerRecommendationBlocks(workspaceData?.workspace.sharedContext ?? ""),
    [workspaceData?.workspace.sharedContext],
  );
  const isOffline = healthQuery.isError && (healthQuery.failureCount ?? 0) >= 3;
  const isReconnecting = healthQuery.isError && (healthQuery.failureCount ?? 0) < 3;
  const workspaceHasContent = agents.length > 0 || contexts.length > 0;
  const errorCount = agents.filter((agent) => agent.state === "ERROR").length;
  const idleCount = agents.filter((agent) => agent.state === "IDLE").length;
  const waitingCount = agents.filter((agent) => agent.state === "WAITING_INPUT").length;
  const attentionCount = agents.filter(
    (agent) =>
      agent.state === "ERROR" ||
      agent.state === "IDLE" ||
      agent.state === "WAITING_INPUT" ||
      agent.state === "WAITING_APPROVAL",
  ).length;
  const canRenameWorkspace = workspaceData
    ? workspaceNameDraft.trim().length > 0 &&
      (workspaceNameDraft.trim() !== workspaceData.workspace.name ||
        workspaceProjectRootDraft.trim() !== workspaceData.workspace.projectRoot)
    : false;
  const canRenameAgent = selectedAgent
    ? (agentTitleDraft.trim().length > 0 && agentTitleDraft.trim() !== selectedAgent.title) ||
      agentWorkingDirectoryDraft.trim() !==
        (typeof selectedAgent.metadata.cwd === "string" ? selectedAgent.metadata.cwd : "")
    : false;
  const canSaveSharedContext = workspaceData ? sharedContextDraft !== workspaceData.workspace.sharedContext : false;
  const canCreateAgent = Boolean(
    workspaceData &&
      agentModelDraft.trim() &&
      agentRoleDraft.trim() &&
      agentTaskDraft.trim(),
  );
  const canRequestPlannerSuggestion = Boolean(
    workspaceData &&
      plannerModelDraft.trim() &&
      plannerTaskDraft.trim(),
  );
  const canSendAgentInput = Boolean(selectedAgent && agentInputDraft.trim().length > 0);
  const hasPendingSettingsChanges =
    openaiApiKey.trim().length > 0 || anthropicApiKey.trim().length > 0 || coordinationApiKey.trim().length > 0;
  const agentTitleMap = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.title])),
    [agents],
  );
  const selectedAgentEventStats = useMemo(() => {
    const counts = {
      total: agentEvents.length,
      outputs: 0,
      errors: 0,
      toolCalls: 0,
      usageTicks: 0,
      heartbeats: 0,
    };
    let latestError: AgentEventRecord | null = null;
    let latestToolCall: AgentEventRecord | null = null;

    for (const event of [...agentEvents].reverse()) {
      if (event.type === "OUTPUT_DELTA" || event.type === "OUTPUT_FINAL") {
        counts.outputs += 1;
      }
      if (event.type === "ERROR") {
        counts.errors += 1;
        if (!latestError) {
          latestError = event;
        }
      }
      if (event.type === "TOOL_CALL_STARTED" || event.type === "TOOL_CALL_FINISHED") {
        counts.toolCalls += 1;
        if (!latestToolCall) {
          latestToolCall = event;
        }
      }
      if (event.type === "USAGE_TICK") {
        counts.usageTicks += 1;
      }
      if (event.type === "HEARTBEAT") {
        counts.heartbeats += 1;
      }
    }

    return {
      counts,
      latestError,
      latestToolCall,
    };
  }, [agentEvents]);

  const visibleTiles = useMemo(() => {
    return orderedAgents.filter((tile) => {
      if (filter === "active") {
        return (
          tile.state === "RUNNING" ||
          tile.state === "WAITING_INPUT" ||
          tile.state === "WAITING_APPROVAL" ||
          Boolean(pendingRunRequests[tile.id])
        );
      }

      if (filter === "idle") {
        return tile.state === "IDLE";
      }

      if (filter === "errors") {
        return tile.state === "ERROR";
      }

      return true;
    });
  }, [filter, orderedAgents, pendingRunRequests]);
  const persistedFleetActivityFeed = useMemo(
    () =>
      (workspaceEventsQuery.data ?? [])
        .map((event) =>
          createFleetActivityFromEvent(
            event,
            agentTitleMap.get(event.agentId) ?? agentTitleLookupRef.current.get(event.agentId) ?? event.agentId,
          ),
        )
        .filter((item): item is FleetActivityItem => item !== null),
    [agentTitleMap, workspaceEventsQuery.data],
  );
  const mergedFleetActivity = useMemo(
    () => collapseFleetActivity([...persistedFleetActivityFeed, ...fleetActivityFeed]),
    [fleetActivityFeed, persistedFleetActivityFeed],
  );
  const conversationFleetActivity = useMemo(
    () => collapseFleetActivity([...persistedFleetActivityFeed, ...fleetActivityFeed], 200),
    [fleetActivityFeed, persistedFleetActivityFeed],
  );
  const latestFleetActivityByAgent = useMemo(() => {
    const latestByAgent = new Map<string, FleetActivityItem>();

    for (const item of mergedFleetActivity) {
      const current = latestByAgent.get(item.agentId);
      if (!current || compareFleetActivityOrder(current, item) <= 0) {
        latestByAgent.set(item.agentId, item);
      }
    }

    return latestByAgent;
  }, [mergedFleetActivity]);
  const workspaceActivityFeed = useMemo(
    () =>
      workspaceFocusedAgent
        ? mergedFleetActivity.filter((item) => item.agentId === workspaceFocusedAgent.id)
        : mergedFleetActivity,
    [mergedFleetActivity, workspaceFocusedAgent],
  );
  const filteredWorkspaceActivityFeed = useMemo(
    () =>
      workspaceLiveFeedFilter === "errors"
        ? workspaceActivityFeed.filter((item) => item.tone === "danger")
        : workspaceActivityFeed,
    [workspaceActivityFeed, workspaceLiveFeedFilter],
  );
  const workspaceAuditFeed = useMemo(
    () =>
      filteredWorkspaceActivityFeed.filter((item) => !isPrimaryWorkspaceConversationActivity(item)),
    [filteredWorkspaceActivityFeed],
  );
  const workspaceAuditErrorCount = useMemo(
    () => workspaceAuditFeed.filter((item) => item.tone === "danger").length,
    [workspaceAuditFeed],
  );
  const workspacePulseLabel = useMemo(() => buildOpsPulseCompact(agents), [agents]);
  const runningAgents = useMemo(
    () => agents.filter((agent) => ["RUNNING", "WAITING_APPROVAL"].includes(agent.state)),
    [agents],
  );
  const stoppableAgents = useMemo(
    () => agents.filter((agent) => !["STOPPED", "COMPLETED"].includes(agent.state)),
    [agents],
  );
  const visibleStoppableAgents = useMemo(
    () => visibleTiles.filter((agent) => !["STOPPED", "COMPLETED"].includes(agent.state)),
    [visibleTiles],
  );
  const workspaceStopTargetCount =
    workspaceStopScope === "all"
      ? stoppableAgents.length
      : workspaceStopScope === "running"
        ? runningAgents.length
        : visibleStoppableAgents.length;
  const selectedAgentActivityFeed = useMemo(
    () =>
      selectedAgent
        ? mergedFleetActivity.filter((item) => item.agentId === selectedAgent.id).slice(0, 10)
        : [],
    [mergedFleetActivity, selectedAgent],
  );
  const workspaceConversationGroups = useMemo<WorkspacePromptGroup[]>(() => {
    const sortedPrompts = [...workspaceThreadEntries]
      .filter((entry) =>
        workspaceFocusedAgent ? entry.scope !== "agent" || entry.agentId === workspaceFocusedAgent.id : true,
      )
      .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));

    if (sortedPrompts.length === 0) {
      return [];
    }

    const agentById = new Map(orderedAgents.map((agent) => [agent.id, agent]));
    const relevantActivities = [...conversationFleetActivity]
      .filter((item) =>
        workspaceFocusedAgent ? item.agentId === workspaceFocusedAgent.id : isWorkspaceConversationReplyActivity(item),
      )
      .sort(compareFleetActivityOrder);
    const relevantAuditItems = [...workspaceAuditFeed].sort(compareFleetActivityOrder);

    const lastPromptIdByAgent = new Map<string, string>();
    for (const prompt of sortedPrompts) {
      const promptTargetIds =
        prompt.scope === "agent"
          ? prompt.agentId
            ? [prompt.agentId]
            : []
          : prompt.targetAgentIds?.length
            ? prompt.targetAgentIds
            : orderedAgents.map((agent) => agent.id);

      for (const agentId of promptTargetIds) {
        if (!workspaceFocusedAgent || agentId === workspaceFocusedAgent.id) {
          lastPromptIdByAgent.set(agentId, prompt.id);
        }
      }
    }

    return sortedPrompts
      .map((prompt, index) => {
        const nextPrompt = sortedPrompts[index + 1];
        const promptStartedAt = Date.parse(prompt.ts);
        const promptEndedAt = nextPrompt ? Date.parse(nextPrompt.ts) : Number.POSITIVE_INFINITY;
        const targetAgentIds =
          prompt.scope === "agent"
            ? prompt.agentId
              ? [prompt.agentId]
              : []
          : prompt.targetAgentIds?.length
            ? prompt.targetAgentIds
            : orderedAgents.map((agent) => agent.id);
        const visibleTargetAgentIds = workspaceFocusedAgent
          ? targetAgentIds.filter((agentId) => agentId === workspaceFocusedAgent.id)
          : targetAgentIds;
        const liveReplyByAgent = new Map<string, FleetActivityItem>();
        const agentThreads: WorkspaceAgentThread[] = [];
        const coordinationFindings =
          workspaceCoordinationState?.findingSummaries
            .filter((finding) => {
              const findingTs = Date.parse(finding.updatedAt);
              if (!Number.isFinite(findingTs) || findingTs < promptStartedAt || findingTs >= promptEndedAt) {
                return false;
              }

              return visibleTargetAgentIds.includes(finding.agentId);
            })
            .map((finding) => ({
              id: finding.id,
              findingType: finding.findingType,
              agentTitle: finding.agentTitle,
              summary: finding.summary,
              detail: finding.detail,
              ts: finding.updatedAt,
            }))
            .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
            .slice(0, 4) ?? [];
        const coordinationQueue: WorkspaceCoordinationQueueItem[] = [];
        const coordinationNeedsInputRequestIds: string[] = [];
        const pendingAgentTitles: string[] = [];

        for (const item of relevantActivities) {
          const itemTs = Date.parse(item.ts);
          if (!Number.isFinite(itemTs) || itemTs < promptStartedAt || itemTs >= promptEndedAt) {
            continue;
          }

          if (!visibleTargetAgentIds.includes(item.agentId)) {
            continue;
          }

          liveReplyByAgent.set(item.agentId, item);
        }

        const auditItems = relevantAuditItems.filter((item) => {
          const itemTs = Date.parse(item.ts);
          if (!Number.isFinite(itemTs) || itemTs < promptStartedAt || itemTs >= promptEndedAt) {
            return false;
          }

          return visibleTargetAgentIds.includes(item.agentId);
        });

        for (const agentId of visibleTargetAgentIds) {
          const agent = agentById.get(agentId);
          if (!agent) {
            continue;
          }

          const promptRuns = (workspaceAgentRunsByAgentId.get(agentId) ?? []).filter((run) => {
            const startedAtMs = Date.parse(run.startedAt || run.createdAt);
            return Number.isFinite(startedAtMs) && startedAtMs >= promptStartedAt && startedAtMs < promptEndedAt;
          });
          const replies: WorkspaceConversationReply[] = [];
          const approvals: WorkspaceConversationReply[] = [];
          let latestTs = prompt.ts;

          for (const run of promptRuns) {
            const transcript = workspaceRunTranscriptByRunId.get(run.id) ?? [];
            const transcriptReplies = transcript.filter(
              (entry) => entry.entryType === "assistant" || entry.entryType === "error",
            );

            for (const entry of transcriptReplies) {
              replies.push({
                id: `workspace-transcript-${entry.id}`,
                agentId,
                agentTitle: agent.title,
                ts: entry.createdAt,
                kind: entry.entryType === "error" ? "error" : "reply",
                content: entry.content,
                detail:
                  entry.entryType === "error"
                    ? typeof entry.metadata.message === "string"
                      ? entry.metadata.message
                      : run.errorMessage
                    : undefined,
                runId: run.id,
              });
              if (Date.parse(entry.createdAt) > Date.parse(latestTs)) {
                latestTs = entry.createdAt;
              }
            }

            if (transcriptReplies.length === 0 && run.state === "ERROR" && run.errorMessage) {
              const isRateLimit = /rate.?limit|429|tokens per min/i.test(run.errorMessage);
              replies.push({
                id: `workspace-run-error-${run.id}`,
                agentId,
                agentTitle: agent.title,
                ts: run.completedAt || run.updatedAt,
                kind: isRateLimit ? "rate_limit" : "error",
                content: run.errorMessage,
                runId: run.id,
                prompt: run.prompt,
              });
              if (Date.parse(run.completedAt || run.updatedAt) > Date.parse(latestTs)) {
                latestTs = run.completedAt || run.updatedAt;
              }
            }
          }

          if (replies.length === 0) {
            const liveItem = liveReplyByAgent.get(agentId);
            if (liveItem) {
              replies.push({
                id: liveItem.id,
                agentId: liveItem.agentId,
                agentTitle: liveItem.agentTitle,
                ts: liveItem.ts,
                kind: liveItem.tone === "danger" ? "error" : "reply",
                content: liveItem.rawText ?? liveItem.summary,
                detail: liveItem.tone === "danger" ? liveItem.detail : undefined,
                streaming: liveItem.eventType === "OUTPUT_DELTA",
                runId: liveItem.runId,
              });
              if (Date.parse(liveItem.ts) > Date.parse(latestTs)) {
                latestTs = liveItem.ts;
              }
            }
          }

          const agentApprovals = pendingApprovals.filter((approval) => approval.agentId === agentId);
          if (agentApprovals.length > 0 && lastPromptIdByAgent.get(agentId) === prompt.id) {
            for (const approval of agentApprovals) {
              approvals.push({
                id: `workspace-approval-${approval.id}`,
                agentId,
                agentTitle: agent.title,
                ts: approval.createdAt,
                kind: "approval",
                content: approval.reason || `Approval requested: ${approval.requestedAction}`,
                detail: approval.requestedAction,
                approval,
              });
              if (Date.parse(approval.createdAt) > Date.parse(latestTs)) {
                latestTs = approval.createdAt;
              }
            }
          }

          const needsInput =
            agent.state === "WAITING_INPUT" && lastPromptIdByAgent.get(agentId) === prompt.id;
          const promptRunIds = new Set(promptRuns.map((run) => run.id));
          const coordinationNeedsInput =
            workspaceCoordinationState?.actionRequests
              .filter((request) => {
                if (request.kind !== "needs_input" || request.agentId !== agentId) {
                  return false;
                }

                const requestTs = Date.parse(request.updatedAt);
                if (!Number.isFinite(requestTs) || requestTs < promptStartedAt || requestTs >= promptEndedAt) {
                  return false;
                }

                return !request.runId || promptRunIds.has(request.runId) || lastPromptIdByAgent.get(agentId) === prompt.id;
              })
              .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
              .at(0) ?? null;
          if (needsInput && Date.parse(agent.lastEventAt) > Date.parse(latestTs)) {
            latestTs = agent.lastEventAt;
          }

          const handoffs = workspaceInbox
            .filter((handoff) => handoff.sourceAgentId === agentId && promptRunIds.has(handoff.sourceRunId))
            .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

          if (handoffs.length > 0) {
            const latestHandoffTs = handoffs[handoffs.length - 1]?.createdAt;
            if (latestHandoffTs && Date.parse(latestHandoffTs) > Date.parse(latestTs)) {
              latestTs = latestHandoffTs;
            }
          }

          const latestAgentAuditItem = auditItems.filter((item) => item.agentId === agentId).at(-1);

          if (
            replies.length === 0 &&
            latestAgentAuditItem &&
            (needsInput || latestAgentAuditItem.tone === "danger" || approvals.length > 0 || handoffs.length > 0)
          ) {
            const fallback = buildConversationFallbackFromActivity(latestAgentAuditItem);
            replies.push({
              id: `workspace-activity-fallback-${latestAgentAuditItem.id}`,
              agentId,
              agentTitle: agent.title,
              ts: latestAgentAuditItem.ts,
              kind:
                needsInput && latestAgentAuditItem.tone !== "danger"
                  ? "needs_input"
                  : latestAgentAuditItem.tone === "danger"
                    ? "error"
                    : "reply",
              content: fallback.content,
              detail: fallback.detail,
              runId: latestAgentAuditItem.runId,
            });
            if (Date.parse(latestAgentAuditItem.ts) > Date.parse(latestTs)) {
              latestTs = latestAgentAuditItem.ts;
            }
          }

          if (replies.length === 0 && needsInput) {
            replies.push({
              id: `workspace-needs-input-${prompt.id}-${agentId}`,
              agentId,
              agentTitle: agent.title,
              ts: agent.lastEventAt || prompt.ts,
              kind: "needs_input",
              content: `${agent.title} is waiting for your next instruction.`,
              detail: "Reply inline below to continue this run from Workspace.",
            });
          }

          replies.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
          approvals.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));

          const latestReply =
            [...replies].reverse().find((reply) => reply.kind === "reply" || reply.kind === "error") ?? null;
          const explicitAgentAsk =
            [...replies].reverse().find((reply) => reply.kind === "needs_input") ?? null;
          const actionRequestCopy = coordinationNeedsInput
            ? {
                content: coordinationNeedsInput.summary,
                detail:
                  coordinationNeedsInput.detail ||
                  "Reply inline below to continue this branch without leaving Workspace.",
                ts: coordinationNeedsInput.updatedAt,
              }
            : needsInput
              ? {
                  ...getWorkspaceActionRequestCopy(agent.title, latestReply, explicitAgentAsk),
                  ts: agent.lastEventAt || latestTs,
                }
              : null;

          if (approvals.length > 0) {
            coordinationQueue.push(
              ...approvals
                .filter((reply) => reply.approval)
                .map((reply) => ({
                  id: reply.id,
                  agentId,
                  agentTitle: agent.title,
                  ts: reply.ts,
                  kind: "approval" as const,
                  content: reply.content,
                  detail: reply.detail,
                  approval: reply.approval,
                })),
            );
          }

          if (actionRequestCopy) {
            if (!workspaceFocusedAgent && coordinationNeedsInput) {
              coordinationNeedsInputRequestIds.push(coordinationNeedsInput.id);
            } else {
              coordinationQueue.push({
                id: `workspace-needs-input-queue-${prompt.id}-${agentId}`,
                agentId,
                agentTitle: agent.title,
                ts: actionRequestCopy.ts,
                kind: "needs_input",
                content: actionRequestCopy.content,
                detail: actionRequestCopy.detail,
              });
            }
          }

          if (handoffs.length > 0) {
            coordinationQueue.push(
              ...handoffs.map((handoff) => ({
                id: `workspace-handoff-${handoff.id}`,
                agentId,
                agentTitle: agent.title,
                ts: handoff.updatedAt,
                kind: "handoff_follow_up" as const,
                content: handoff.title,
                detail: handoff.summary,
                handoff,
              })),
            );
          }

          if (replies.length > 0 || approvals.length > 0 || needsInput || handoffs.length > 0) {
            agentThreads.push({
              agentId,
              agentTitle: agent.title,
              agentState: agent.state,
              replies,
              approvals,
              needsInput,
              needsInputRequest: actionRequestCopy,
              latestTs,
              handoffs,
            });
          } else {
            pendingAgentTitles.push(agent.title);
          }
        }

        agentThreads.sort((left, right) => {
          const leftOrder = agentExecutionOrderById.get(left.agentId);
          const rightOrder = agentExecutionOrderById.get(right.agentId);

          if (typeof leftOrder === "number" && typeof rightOrder === "number" && leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }

          if (typeof leftOrder === "number") {
            return -1;
          }

          if (typeof rightOrder === "number") {
            return 1;
          }

          return Date.parse(left.latestTs) - Date.parse(right.latestTs);
        });
        coordinationQueue.sort((left, right) => {
          const leftOrder = agentExecutionOrderById.get(left.agentId);
          const rightOrder = agentExecutionOrderById.get(right.agentId);

          if (typeof leftOrder === "number" && typeof rightOrder === "number" && leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }

          if (typeof leftOrder === "number") {
            return -1;
          }

          if (typeof rightOrder === "number") {
            return 1;
          }

          return Date.parse(left.ts) - Date.parse(right.ts);
        });

        // Show the team ask card if it exists in coordination state and has not been dismissed.
        // The carry-forward logic on the backend preserves asks across restarts, so we don't
        // filter by active needs_input request IDs here.
        const teamAsk =
          !workspaceFocusedAgent &&
          workspaceCoordinationState?.teamAsk &&
          !workspaceCoordinationState.teamAsk.dismissed
            ? {
                id: workspaceCoordinationState.teamAsk.id,
                title: workspaceCoordinationState.teamAsk.title,
                summary: workspaceCoordinationState.teamAsk.summary,
                detail: workspaceCoordinationState.teamAsk.detail,
                agentIds: workspaceCoordinationState.teamAsk.agentIds,
                requestIds: workspaceCoordinationState.teamAsk.requestIds,
                blockedBranches: workspaceCoordinationState.teamAsk.blockedBranches ?? [],
                recommendedResponseShape: workspaceCoordinationState.teamAsk.recommendedResponseShape ?? "direction",
                ts: workspaceCoordinationState.teamAsk.updatedAt,
                synthesized: workspaceCoordinationState.teamAsk.synthesized,
              }
            : null;

        // Only show coordination queue items for agents that are in this prompt group
        const filteredCoordinationQueue = coordinationQueue.filter(
          (item) => agentThreads.some((thread) => thread.agentId === item.agentId),
        );

        return {
          prompt,
          targetCount: visibleTargetAgentIds.length,
          agentThreads,
          coordinationQueue: filteredCoordinationQueue,
          coordinationFindings,
          teamAsk,
          pendingAgentTitles,
        };
      })
      .filter((group) => group.targetCount > 0);
  }, [
    agentExecutionOrderById,
    conversationFleetActivity,
    orderedAgents,
    pendingApprovals,
    workspaceCoordinationState,
    workspaceAgentRunsByAgentId,
    workspaceAuditFeed,
    workspaceFocusedAgent,
    workspaceInbox,
    workspaceRunTranscriptByRunId,
    workspaceThreadEntries,
  ]);
  const activeWorkspaceTeamAsk = useMemo(() => {
    if (workspaceFocusedAgent) {
      return null;
    }

    for (let index = workspaceConversationGroups.length - 1; index >= 0; index -= 1) {
      const group = workspaceConversationGroups[index];
      if (group?.teamAsk) {
        return group.teamAsk;
      }
    }

    return null;
  }, [workspaceConversationGroups, workspaceFocusedAgent]);
  const workspaceComposerTargetAgents = useMemo(() => {
    if (workspaceFocusedAgent) {
      return [workspaceFocusedAgent];
    }

    if (activeWorkspaceTeamAsk) {
      return sortAgentsByExecutionOrder(
        orderedAgents.filter((agent) => activeWorkspaceTeamAsk.agentIds.includes(agent.id)),
        agentExecutionOrderById,
      );
    }

    return sortAgentsByExecutionOrder(visibleTiles, agentExecutionOrderById);
  }, [activeWorkspaceTeamAsk, agentExecutionOrderById, orderedAgents, visibleTiles, workspaceFocusedAgent]);
  const broadcastTargetCount = workspaceComposerTargetAgents.length;
  const canBroadcastToAgents = Boolean(
    workspaceComposerTargetAgents.length > 0 && broadcastInputDraft.trim().length > 0,
  );
  useEffect(() => {
    if (homeThread.kind !== "workspace" || workspaceThreadTab !== "conversation") {
      return;
    }

    const container = workspaceConversationStreamRef.current;
    if (!container) {
      return;
    }

    if (!workspaceShouldAutoScrollRef.current) {
      return;
    }

    // Only fire auto-scroll when the scroll height has grown meaningfully
    const newScrollHeight = container.scrollHeight;
    if (newScrollHeight <= workspaceScrollHeightRef.current + 4) {
      return;
    }
    workspaceScrollHeightRef.current = newScrollHeight;

    const frameId = window.requestAnimationFrame(() => {
      const c = workspaceConversationStreamRef.current;
      if (!c) return;

      const activeElement = document.activeElement;
      const isEditing =
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLInputElement;

      scrollWorkspaceConversationToLatest(isEditing ? "auto" : "smooth");
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [homeThread.kind, workspaceConversationGroups, workspaceThreadTab]);
  // When workspace changes, reset scroll state so the conversation always opens at the bottom.
  useEffect(() => {
    workspaceShouldAutoScrollRef.current = true;
    workspaceScrollHeightRef.current = 0;
  }, [activeWorkspaceId]);

  const plannerConversationItems = useMemo(
    () => [...plannerThreadEntries].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts)),
    [plannerThreadEntries],
  );

  const projectTreeNodes = useMemo(() => sortFileTreeNodes(projectTreeQuery.data ?? []), [projectTreeQuery.data]);
  const agentArtifacts = agentArtifactsQuery.data ?? [];
  const explorerSearchTerm = explorerSearchDraft.trim().toLowerCase();
  const explorerSearchResults = useMemo(() => {
    if (!explorerSearchTerm) {
      return [];
    }

    const searchRoot = explorerBoundaryRoot || explorerRoot || "/";
    return flattenFileTree(projectTreeNodes)
      .filter((node) => isNodeMatch(node, explorerSearchTerm, searchRoot))
      .slice(0, 200);
  }, [explorerBoundaryRoot, explorerRoot, explorerSearchTerm, projectTreeNodes]);
  const explorerDisplayRoot = explorerRoot || defaultExplorerRoot;
  const selectedExplorerDisplayPath =
    selectedExplorerFilePath && explorerBoundaryRoot
      ? getRelativePath(explorerBoundaryRoot, selectedExplorerFilePath)
      : selectedExplorerFilePath;
  const canEditExplorerFile =
    Boolean(selectedExplorerFilePath) && !selectedExplorerTruncated && !filePreviewPending;
  const explorerFileDirty = canEditExplorerFile && selectedExplorerContent !== selectedExplorerLoadedContent;
  const selectedRunThreadTimeline = useMemo(
    () =>
      [
        ...selectedRunConversation.map((entry) => ({
          id: `conversation-${entry.id}`,
          ts: entry.createdAt,
          kind: "conversation" as const,
          entry,
        })),
        ...selectedRunActivity.map((entry) => ({
          id: `activity-${entry.id}`,
          ts: entry.createdAt,
          kind: "activity" as const,
          entry,
        })),
        ...runToolCalls.map((toolCall) => ({
          id: `tool-${toolCall.id}`,
          ts: toolCall.updatedAt,
          kind: "toolCall" as const,
          toolCall,
        })),
        ...runArtifacts.map((artifact) => ({
          id: `artifact-${artifact.id}`,
          ts: artifact.createdAt,
          kind: "artifact" as const,
          artifact,
        })),
      ].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts)),
    [runArtifacts, runToolCalls, selectedRunActivity, selectedRunConversation],
  );

  const previewableArtifacts = useMemo(
    () => runArtifacts.filter((artifact) => ["patch", "log", "trace"].includes(artifact.kind)),
    [runArtifacts],
  );

  useEffect(() => {
    if (!isTauriRuntime() || previewableArtifacts.length === 0) {
      return;
    }

    const missingArtifacts = previewableArtifacts.filter((artifact) => !artifactPreviewCache[artifact.uri]);
    if (missingArtifacts.length === 0) {
      return;
    }

    let cancelled = false;

    void Promise.all(
      missingArtifacts.map(async (artifact) => {
        try {
          const preview = await readProjectFile(artifact.uri);
          if (cancelled) {
            return;
          }

          setArtifactPreviewCache((current) => ({
            ...current,
            [artifact.uri]: {
              content: preview.content,
              truncated: preview.truncated,
            },
          }));
        } catch (error) {
          if (cancelled) {
            return;
          }

          setArtifactPreviewCache((current) => ({
            ...current,
            [artifact.uri]: {
              content: "",
              truncated: false,
              error:
                error instanceof Error
                  ? error.message
                  : `Unable to load the ${artifact.kind} preview.`,
            },
          }));
        }
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [artifactPreviewCache, previewableArtifacts]);

  const agentStatusOverrides = useMemo(() => {
    const overrides = new Map<string, { label: string; tone: FleetActivityTone }>();

    for (const [agentId] of Object.entries(pendingRunRequests)) {
      overrides.set(agentId, {
        label: "Run requested",
        tone: "info",
      });
    }

    return overrides;
  }, [pendingRunRequests]);

  function appendFleetActivity(items: FleetActivityItem[]): void {
    setFleetActivityFeed((current) => {
      const next = [...current];

      for (const item of items) {
        if (!next.some((existing) => existing.id === item.id)) {
          next.push(item);
        }
      }

      return next
        .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts))
        .slice(-180);
    });
  }

  function appendPlannerThreadEntries(entries: PlannerThreadEntry[]): void {
    setPlannerThreadEntries((current) => {
      const next = [...current];

      for (const entry of entries) {
        if (!next.some((existing) => existing.id === entry.id)) {
          next.push(entry);
        }
      }

      return next
        .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts))
        .slice(-80);
    });
  }

  function openExplorerFile(path: string): void {
    setOpenExplorerTabs((current) => (current.includes(path) ? current : [...current, path]));
    setSelectedExplorerFilePath(path);
  }

  function closeExplorerFile(path: string): void {
    setOpenExplorerTabs((current) => {
      const next = current.filter((item) => item !== path);
      if (selectedExplorerFilePath === path) {
        const nextSelected = next[next.length - 1] ?? "";
        setSelectedExplorerFilePath(nextSelected);
      }
      return next;
    });
  }

  useEffect(() => {
    const firstWorkspace = workspacesQuery.data?.[0];

    if (!activeWorkspaceId && firstWorkspace) {
      setActiveWorkspaceId(firstWorkspace.id);
      setWorkspaceNameDraft(firstWorkspace.name);
    }
  }, [activeWorkspaceId, workspacesQuery.data]);

  useEffect(() => {
    agentTitleLookupRef.current = new Map(agents.map((agent) => [agent.id, agent.title]));
  }, [agents]);

  useEffect(() => {
    setFleetActivityFeed([]);
    setPlannerThreadEntries([]);
    previousAgentSnapshotsRef.current = new Map();
    setPendingRunRequests({});
  }, [activeWorkspaceId]);

  useEffect(() => {
    const previousSnapshots = previousAgentSnapshotsRef.current;
    const nextSnapshots = new Map<string, { state: AgentSessionRecord["state"]; lastEventAt: string; preview: string }>();
    const nextActivity: FleetActivityItem[] = [];

    for (const agent of agents) {
      const preview = getAgentPreview(agent);
      const snapshot = {
        state: agent.state,
        lastEventAt: agent.lastEventAt,
        preview,
      };

      const previous = previousSnapshots.get(agent.id);
      if (
        previous &&
        (previous.state !== snapshot.state ||
          previous.lastEventAt !== snapshot.lastEventAt ||
          previous.preview !== snapshot.preview)
      ) {
        const activity = summarizeAgentSnapshot(agent);
        nextActivity.push({
          id: `poll-${agent.id}-${snapshot.lastEventAt}-${snapshot.state}`,
          agentId: agent.id,
          agentTitle: agent.title,
          ts: snapshot.lastEventAt,
          summary: activity.summary,
          detail: activity.detail,
          tone: activity.tone,
          source: "poll",
        });
      }

      nextSnapshots.set(agent.id, snapshot);
    }

    previousAgentSnapshotsRef.current = nextSnapshots;
    if (nextActivity.length > 0) {
      appendFleetActivity(nextActivity);
    }

    setPendingRunRequests((current) => {
      let changed = false;
      const next = { ...current };

      for (const agent of agents) {
        if (next[agent.id] && agent.state !== "CREATED") {
          delete next[agent.id];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [agents]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setStreamConnected(false);
      return;
    }

    const socket = new WebSocket(getControlPlaneStreamUrl(activeWorkspaceId));

    socket.addEventListener("open", () => {
      setStreamConnected(true);
    });

    socket.addEventListener("close", () => {
      setStreamConnected(false);
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as EventStreamMessage;

      if (message.kind !== "agent_event") {
        return;
      }

      if (!shouldShowFleetActivityEvent(message.event)) {
        return;
      }

      const activity = createFleetActivityFromEvent(
        message.event,
        agentTitleLookupRef.current.get(message.event.agentId) ?? message.event.agentId,
      );
      if (activity) {
        appendFleetActivity([activity]);
      }
      if (["STATUS_CHANGED", "SESSION_COMPLETED", "ERROR"].includes(message.event.type)) {
        setPendingRunRequests((current) => {
          if (!current[message.event.agentId]) {
            return current;
          }

          const next = { ...current };
          delete next[message.event.agentId];
          return next;
        });
      }

      void queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-events", activeWorkspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["pending-approvals", activeWorkspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-inbox", activeWorkspaceId] });

      if (message.event.agentId === selectedAgentId) {
        void queryClient.invalidateQueries({ queryKey: ["agent-events", selectedAgentId] });
        void queryClient.invalidateQueries({ queryKey: ["agent-runs", selectedAgentId] });
        if (selectedRunId) {
          void queryClient.invalidateQueries({ queryKey: ["run-transcript", selectedRunId] });
          void queryClient.invalidateQueries({ queryKey: ["run-tool-calls", selectedRunId] });
          void queryClient.invalidateQueries({ queryKey: ["run-artifacts", selectedRunId] });
        }
      }
    });

    socket.addEventListener("error", () => {
      setStreamConnected(false);
    });

    return () => {
      socket.close();
    };
  }, [activeWorkspaceId, queryClient, selectedAgentId, selectedRunId]);

  useEffect(() => {
    if (workspaceData) {
      setWorkspaceNameDraft(workspaceData.workspace.name);
      setWorkspaceProjectRootDraft(workspaceData.workspace.projectRoot);
      setSharedContextDraft(workspaceData.workspace.sharedContext);
      setAgentCwdDraft(workspaceData.workspace.projectRoot);
      setDeleteWorkspaceArmed(false);
      setSelectedProjectFiles([]);
      setSelectedContextPackIds([]);
    }
  }, [workspaceData]);

  useEffect(() => {
    if (homeThread.kind !== "workspace" || !workspaceDraftStorageKey) {
      return;
    }

    try {
      const raw = window.localStorage.getItem(workspaceDraftStorageKey);
      if (!raw) {
        setBroadcastInputDraft("");
        return;
      }

      const parsed = JSON.parse(raw) as {
        input?: string;
      };
      setBroadcastInputDraft(parsed.input ?? "");
    } catch {
      setBroadcastInputDraft("");
    }
  }, [homeThread.kind, workspaceDraftStorageKey]);

  useEffect(() => {
    if (!workspaceDraftStorageKey) {
      return;
    }

    try {
      window.localStorage.setItem(
        workspaceDraftStorageKey,
        JSON.stringify({
          input: broadcastInputDraft,
        }),
      );
    } catch {
      // Ignore local draft persistence failures in the desktop shell.
    }
  }, [broadcastInputDraft, workspaceDraftStorageKey]);

  useEffect(() => {
    if (homeThread.kind !== "planner" || !plannerDraftStorageKey) {
      return;
    }

    try {
      const raw = window.localStorage.getItem(plannerDraftStorageKey);
      if (!raw) {
        setPlannerTaskDraft("");
        setPlannerConstraintsDraft("");
        return;
      }

      const parsed = JSON.parse(raw) as {
        task?: string;
        constraints?: string;
        provider?: "codex" | "claude";
        model?: string;
      };
      setPlannerTaskDraft(parsed.task ?? "");
      setPlannerConstraintsDraft(parsed.constraints ?? "");
      if (parsed.provider === "codex" || parsed.provider === "claude") {
        setPlannerProviderDraft(parsed.provider);
      }
      if (typeof parsed.model === "string" && parsed.model.trim().length > 0) {
        setPlannerModelDraft(parsed.model);
      }
    } catch {
      setPlannerTaskDraft("");
      setPlannerConstraintsDraft("");
    }
  }, [homeThread.kind, plannerDraftStorageKey]);

  useEffect(() => {
    if (!plannerDraftStorageKey) {
      return;
    }

    try {
      window.localStorage.setItem(
        plannerDraftStorageKey,
        JSON.stringify({
          task: plannerTaskDraft,
          constraints: plannerConstraintsDraft,
          provider: plannerProviderDraft,
          model: plannerModelDraft,
        }),
      );
    } catch {
      // Ignore local draft persistence failures in the desktop shell.
    }
  }, [
    plannerConstraintsDraft,
    plannerDraftStorageKey,
    plannerModelDraft,
    plannerProviderDraft,
    plannerTaskDraft,
  ]);

  useEffect(() => {
    if (homeThread.kind !== "agent" || !agentDraftStorageKey) {
      return;
    }

    try {
      const raw = window.localStorage.getItem(agentDraftStorageKey);
      setAgentInputDraft(raw ? String(JSON.parse(raw).input ?? "") : "");
    } catch {
      setAgentInputDraft("");
    }
  }, [agentDraftStorageKey, homeThread.kind]);

  useEffect(() => {
    if (!agentDraftStorageKey) {
      return;
    }

    try {
      window.localStorage.setItem(agentDraftStorageKey, JSON.stringify({ input: agentInputDraft }));
    } catch {
      // Ignore local draft persistence failures in the desktop shell.
    }
  }, [agentDraftStorageKey, agentInputDraft]);

  useEffect(() => {
    setPlannerSuggestionState(null);
    setPlannerAgentDrafts([]);
    setActivePlannerHistoryEntryId("");
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!currentThreadKey || activeMenu === "settings") {
      return;
    }

    const storageKey = `acc.right-sidebar.v1:${currentThreadKey}`;

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { visible?: boolean };
        setRightSidebarVisible(Boolean(parsed.visible));
        return;
      }
    } catch {
      // Ignore malformed persisted sidebar state and fall back to defaults.
    }

    setRightSidebarVisible(homeThread.kind !== "agent");
  }, [activeMenu, currentThreadKey, homeThread.kind]);

  useEffect(() => {
    if (!currentThreadKey || activeMenu === "settings") {
      return;
    }

    try {
      window.localStorage.setItem(
        `acc.right-sidebar.v1:${currentThreadKey}`,
        JSON.stringify({ visible: rightSidebarVisible }),
      );
    } catch {
      // Ignore local storage persistence failures in the desktop shell.
    }
  }, [activeMenu, currentThreadKey, rightSidebarVisible]);

  useEffect(() => {
    setWorkspaceSettingsPopoverOpen(false);
    setWorkspaceSettingsPopoverPosition(null);
  }, [activeWorkspaceId, activeMenu, homeThread]);

  useEffect(() => {
    if (!workspaceSettingsPopoverOpen) {
      return;
    }

    syncWorkspaceSettingsPopoverPosition();

    const handleViewportChange = () => syncWorkspaceSettingsPopoverPosition();

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [workspaceSettingsPopoverOpen]);

  useEffect(() => {
    if (!workspaceFocusedAgentId) {
      return;
    }

    if (agents.some((agent) => agent.id === workspaceFocusedAgentId)) {
      return;
    }

    setWorkspaceFocusedAgentId("");
  }, [agents, workspaceFocusedAgentId]);

  useEffect(() => {
    if (selectedAgent) {
      setAgentTitleDraft(selectedAgent.title);
      setAgentWorkingDirectoryDraft(typeof selectedAgent.metadata.cwd === "string" ? selectedAgent.metadata.cwd : "");
      return;
    }

    if (homeThread.kind === "agent" && visibleTiles.length > 0) {
      setSelectedAgentId(visibleTiles[0].id);
      if (homeThread.agentId !== visibleTiles[0].id) {
        setHomeThread({ kind: "agent", agentId: visibleTiles[0].id });
      }
    } else {
      if (homeThread.kind === "agent") {
        setSelectedAgentId("");
        setAgentTitleDraft("");
        setAgentWorkingDirectoryDraft("");
        setHomeThread({ kind: "workspace" });
      }
    }
  }, [homeThread, selectedAgent, visibleTiles]);

  useEffect(() => {
    const normalizedRoot = normalizePathString(defaultExplorerRoot);
    const storageKey = explorerScopeKey ? `acc.explorer-state.v1:${explorerScopeKey}` : "";

    if (!normalizedRoot) {
      setExplorerRootOverride("");
      setExplorerLocationDraft("");
      setExplorerSearchDraft("");
      setExpandedExplorerPaths([]);
      setSelectedExplorerFilePath("");
      setOpenExplorerTabs([]);
      setSelectedExplorerLoadedContent("");
      setSelectedExplorerContent("");
      setSelectedExplorerTruncated(false);
      return;
    }

    let restoredTabs: string[] = [];
    let restoredSelected = "";
    let restoredRootOverride = "";
    let restoredExpanded: string[] = [];

    if (storageKey) {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            tabs?: string[];
            selected?: string;
            rootOverride?: string;
            expanded?: string[];
          };
          restoredTabs = (parsed.tabs ?? []).filter((path) => isPathInsideRoot(normalizedRoot, normalizePathString(path)));
          restoredSelected =
            typeof parsed.selected === "string" && isPathInsideRoot(normalizedRoot, normalizePathString(parsed.selected))
              ? normalizePathString(parsed.selected)
              : "";
          restoredRootOverride =
            typeof parsed.rootOverride === "string" &&
            parsed.rootOverride.trim().length > 0 &&
            isPathInsideRoot(normalizedRoot, normalizePathString(parsed.rootOverride))
              ? normalizePathString(parsed.rootOverride)
              : "";
          restoredExpanded = (parsed.expanded ?? []).filter((path) =>
            isPathInsideRoot(normalizedRoot, normalizePathString(path)),
          );
        }
      } catch {
        // Ignore malformed persisted explorer state and fall back to defaults.
      }
    }

    const nextSelected =
      restoredSelected && restoredTabs.includes(restoredSelected)
        ? restoredSelected
        : restoredTabs[restoredTabs.length - 1] ?? "";
    const nextRootOverride = restoredRootOverride && restoredRootOverride !== normalizedRoot ? restoredRootOverride : "";

    setExplorerRootOverride(nextRootOverride);
    setExplorerLocationDraft(nextRootOverride || normalizedRoot);
    setExplorerSearchDraft("");
    setExpandedExplorerPaths(restoredExpanded);
    setSelectedExplorerFilePath(nextSelected);
    setOpenExplorerTabs(restoredTabs);
    setSelectedExplorerLoadedContent("");
    setSelectedExplorerContent("");
    setSelectedExplorerTruncated(false);
  }, [defaultExplorerRoot, explorerScopeKey]);

  useEffect(() => {
    if (!explorerScopeKey || !explorerBoundaryRoot) {
      return;
    }

    const storageKey = `acc.explorer-state.v1:${explorerScopeKey}`;
    const payload = {
      tabs: openExplorerTabs.filter((path) => isPathInsideRoot(explorerBoundaryRoot, path)),
      selected:
        selectedExplorerFilePath && isPathInsideRoot(explorerBoundaryRoot, selectedExplorerFilePath)
          ? selectedExplorerFilePath
          : "",
      rootOverride:
        explorerRootOverride && isPathInsideRoot(explorerBoundaryRoot, normalizePathString(explorerRootOverride))
          ? normalizePathString(explorerRootOverride)
          : "",
      expanded: expandedExplorerPaths.filter((path) => isPathInsideRoot(explorerBoundaryRoot, path)),
    };

    try {
      window.localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch {
      // Ignore local storage persistence failures in the desktop shell.
    }
  }, [
    expandedExplorerPaths,
    explorerBoundaryRoot,
    explorerRootOverride,
    explorerScopeKey,
    openExplorerTabs,
    selectedExplorerFilePath,
  ]);

  useEffect(() => {
    if (!explorerRoot) {
      setSelectedExplorerFilePath("");
      setSelectedExplorerContent("");
      setSelectedExplorerLoadedContent("");
      setSelectedExplorerTruncated(false);
      return;
    }

    const normalizedRoot = normalizePathString(explorerRoot);
    if (selectedExplorerFilePath && !isPathInsideRoot(normalizedRoot, selectedExplorerFilePath)) {
      setSelectedExplorerFilePath("");
      setOpenExplorerTabs((current) => current.filter((path) => isPathInsideRoot(normalizedRoot, path)));
      setSelectedExplorerContent("");
      setSelectedExplorerLoadedContent("");
      setSelectedExplorerTruncated(false);
    }
  }, [explorerRoot, selectedExplorerFilePath]);

  useEffect(() => {
    if (selectedRun) {
      if (selectedRunId !== selectedRun.id) {
        setSelectedRunId(selectedRun.id);
      }
      return;
    }

    if (agentRuns.length > 0) {
      setSelectedRunId(agentRuns[0].id);
    } else {
      setSelectedRunId("");
    }
  }, [agentRuns, selectedRun, selectedRunId]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      setCommandPaletteQuery("");
      return;
    }

    commandPaletteInputRef.current?.focus();
  }, [commandPaletteOpen]);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((current) => !current);
      }

      if (event.key === "Escape") {
        setCommandPaletteOpen(false);
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const activeDragState = dragState;

    function handlePointerMove(event: MouseEvent): void {
      if (
        activeDragState.target === "sidebar" &&
        activeDragState.startWidth !== undefined &&
        activeDragState.startX !== undefined
      ) {
        setLeftRailWidth(
          clamp(activeDragState.startWidth + (event.clientX - activeDragState.startX), 148, 220),
        );
      }

      if (
        activeDragState.target === "inspector" &&
        activeDragState.startWidth !== undefined &&
        activeDragState.startX !== undefined
      ) {
        setInspectorWidth(
          clamp(activeDragState.startWidth - (event.clientX - activeDragState.startX), 300, 460),
        );
      }

    }

    function handlePointerUp(): void {
      setDragState(null);
    }

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);

    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    };
  }, [dragState]);

  useEffect(() => {
    if (!selectedExplorerFilePath && projectTreeNodes.length > 0) {
      const firstFile = findFirstVisibleFile(projectTreeNodes) ?? findFirstFile(projectTreeNodes);

      if (firstFile) {
        openExplorerFile(firstFile.path);
      } else {
        setSelectedExplorerContent("");
        setSelectedExplorerTruncated(false);
      }
    }
  }, [projectTreeNodes, selectedExplorerFilePath]);

  useEffect(() => {
    if (!selectedExplorerFilePath) {
      setSelectedExplorerContent("");
      setSelectedExplorerLoadedContent("");
      setSelectedExplorerTruncated(false);
      return;
    }

    let cancelled = false;
    setFilePreviewPending(true);

    void readProjectFile(selectedExplorerFilePath)
      .then((preview) => {
        if (cancelled) {
          return;
        }

        setSelectedExplorerContent(preview.content);
        setSelectedExplorerLoadedContent(preview.content);
        setSelectedExplorerTruncated(preview.truncated);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setSelectedExplorerContent(error instanceof Error ? error.message : "Failed to load file preview.");
        setSelectedExplorerLoadedContent(error instanceof Error ? error.message : "Failed to load file preview.");
        setSelectedExplorerTruncated(false);
      })
      .finally(() => {
        if (!cancelled) {
          setFilePreviewPending(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedExplorerFilePath]);

  useEffect(() => {
    if (!selectedExplorerFilePath) {
      return;
    }

    setOpenExplorerTabs((current) =>
      current.includes(selectedExplorerFilePath) ? current : [...current, selectedExplorerFilePath],
    );
  }, [selectedExplorerFilePath]);

  const offlineBannerTitle =
    settingsAvailable && runtimeStatus?.appOwned
      ? "Embedded control plane unavailable."
      : "Control plane unavailable.";

  const offlineBannerBody =
    settingsAvailable && runtimeStatus?.appOwned
      ? runtimeStatus.lastError
        ? `${runtimeStatus.lastError}. The app will keep retrying in the background.`
        : "The embedded backend is not reachable yet. The app will keep retrying in the background."
      : `Start the local API on ${baseUrl} to populate the command center.`;

  async function handleCreateWorkspace(withDemo: boolean): Promise<void> {
    setWorkspaceNotice({
      tone: "info",
      text: withDemo ? "Creating workspace and loading the demo board..." : "Creating workspace...",
    });

    try {
      const workspace = await createWorkspaceMutation.mutateAsync({
        name: newWorkspaceDraft.trim() || "Agent Command Center",
        description: withDemo ? "Bootstrapped from the desktop shell" : "Created from the desktop shell",
        projectRoot: newWorkspaceProjectRootDraft.trim() || undefined,
      });

      setActiveWorkspaceId(workspace.id);
      setWorkspaceNameDraft(workspace.name);
      setWorkspaceProjectRootDraft(workspace.projectRoot);
      setSharedContextDraft(workspace.sharedContext);
      setNewWorkspaceDraft("Agent Command Center");
      setNewWorkspaceProjectRootDraft("");
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });

      if (withDemo) {
        const result = await bootstrapDemoMutation.mutateAsync(workspace.id);
        setWorkspaceNotice({
          tone: "success",
          text: `Loaded ${result.createdAgents} demo agents and ${result.createdContextPacks} packs in ${workspace.name}.`,
        });
      } else {
        await queryClient.refetchQueries({
          queryKey: ["workspace-overview", workspace.id],
          exact: true,
        });
        setWorkspaceNotice({
          tone: "success",
          text: `Created workspace ${workspace.name}.`,
        });
      }
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Workspace action failed.",
      });
    }
  }

  async function handleSeedDemoBoard(): Promise<void> {
    if (!hasWorkspace) {
      await handleCreateWorkspace(true);
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Loading the demo board in ${workspaceData!.workspace.name}...`,
    });

    try {
      const result = await bootstrapDemoMutation.mutateAsync(activeWorkspaceId);
      setWorkspaceNotice({
        tone: "success",
        text: `Loaded ${result.createdAgents} demo agents and ${result.createdContextPacks} packs in ${workspaceData!.workspace.name}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to load the demo board.",
      });
    }
  }

  async function handleRenameWorkspace(): Promise<void> {
    if (!workspaceData || !canRenameWorkspace) {
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Saving ${workspaceNameDraft.trim()}...`,
    });

    try {
      const workspace = await renameWorkspaceMutation.mutateAsync({
        workspaceId: workspaceData.workspace.id,
        name: workspaceNameDraft.trim(),
        projectRoot: workspaceProjectRootDraft.trim(),
      });

      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-project-files", workspace.id] });
      await queryClient.refetchQueries({
        queryKey: ["workspace-overview", workspace.id],
        exact: true,
      });

      setWorkspaceNotice({
        tone: "success",
        text: `Saved workspace settings for ${workspace.name}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to rename the workspace.",
      });
    }
  }

  async function handleDeleteWorkspace(): Promise<void> {
    if (!workspaceData) {
      return;
    }

    if (!deleteWorkspaceArmed) {
      setDeleteWorkspaceArmed(true);
      setWorkspaceNotice({
        tone: "info",
        text: `Click \"Confirm delete\" to permanently remove ${workspaceData.workspace.name}.`,
      });
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Deleting ${workspaceData.workspace.name}...`,
    });

    try {
      await deleteWorkspaceMutation.mutateAsync(workspaceData.workspace.id);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      const nextWorkspaces = await queryClient.fetchQuery({
        queryKey: ["workspaces"],
        queryFn: fetchWorkspaces,
      });
      const nextWorkspace = nextWorkspaces[0];

      setActiveWorkspaceId(nextWorkspace?.id ?? "");
      setWorkspaceNameDraft(nextWorkspace?.name ?? "");
      setSelectedAgentId("");
      setAgentTitleDraft("");
      setDeleteWorkspaceArmed(false);
      setWorkspaceNotice({
        tone: "success",
        text: `Deleted workspace ${workspaceData.workspace.name}.`,
      });
    } catch (error) {
      setDeleteWorkspaceArmed(false);
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to delete the workspace.",
      });
    }
  }

  async function handleRenameAgent(): Promise<void> {
    if (!selectedAgent || !canRenameAgent) {
      return;
    }

    try {
      await renameAgentMutation.mutateAsync({
        agentId: selectedAgent.id,
        title: agentTitleDraft.trim(),
        cwd: agentWorkingDirectoryDraft,
      });
      setWorkspaceNotice({
        tone: "success",
        text: `Updated ${agentTitleDraft.trim()}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to update the agent.",
      });
    }
  }

  async function handleSaveSharedContext(): Promise<void> {
    if (!workspaceData || !canSaveSharedContext) {
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: "Saving shared context...",
    });

    try {
      const workspace = await saveSharedContextMutation.mutateAsync({
        workspaceId: workspaceData.workspace.id,
        sharedContext: sharedContextDraft,
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
        queryClient.refetchQueries({
          queryKey: ["workspace-overview", workspace.id],
          exact: true,
        }),
      ]);

      setWorkspaceNotice({
        tone: "success",
        text: `Updated shared context for ${workspace.name}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to save shared context.",
      });
    }
  }

  function handleToggleProjectFile(path: string): void {
    setSelectedProjectFiles((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );
  }

  async function handleImportProjectFiles(mode: "append" | "replace"): Promise<void> {
    if (!workspaceData || selectedProjectFiles.length === 0) {
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `${mode === "replace" ? "Replacing" : "Appending"} shared context from selected project files...`,
    });

    try {
      const result = await importSharedContextMutation.mutateAsync({
        workspaceId: workspaceData.workspace.id,
        paths: selectedProjectFiles,
        mode,
      });

      await queryClient.refetchQueries({
        queryKey: ["workspace-overview", workspaceData.workspace.id],
        exact: true,
      });
      await queryClient.invalidateQueries({ queryKey: ["workspace-project-files", workspaceData.workspace.id] });
      setSharedContextDraft(result.workspace.sharedContext);
      setSelectedProjectFiles([]);
      setWorkspaceNotice({
        tone: "success",
        text: `Imported ${result.importedFiles.length} file${result.importedFiles.length === 1 ? "" : "s"} into shared context.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to import project files.",
      });
    }
  }

  async function handleCreateAgent(launchImmediately: boolean): Promise<void> {
    if (!workspaceData || !canCreateAgent) {
      return;
    }

    setAgentFlowPending(true);
    setWorkspaceNotice({
      tone: "info",
      text: launchImmediately ? "Creating and launching agent..." : "Creating agent...",
    });

    try {
      const coordinationContext = await getRenderedCoordinationContext({
        role: agentRoleDraft.trim() || agentTitleCreateDraft.trim() || "Agent",
        title: agentTitleCreateDraft.trim() || agentRoleDraft.trim() || "Agent",
      });
      const taskWithPlannerGuidance = [
        agentTaskDraft.trim(),
        coordinationContext,
      ]
        .filter(Boolean)
        .join("\n\n");
      const agent = await createAgentMutation.mutateAsync({
        workspaceId: workspaceData.workspace.id,
        provider: agentProviderDraft,
        model: agentModelDraft.trim(),
        title: agentTitleCreateDraft.trim() || undefined,
        role: agentRoleDraft.trim(),
        task: taskWithPlannerGuidance,
        cwd: agentCwdDraft.trim() || undefined,
      });

      for (const contextPackId of selectedContextPackIds) {
        await mountContextPack(contextPackId, {
          agentIds: [agent.id],
          maxContextTokens: 8_000,
        });
      }

      if (launchImmediately) {
        await createRunMutation.mutateAsync({
          agentId: agent.id,
          prompt: taskWithPlannerGuidance,
          title: agentRoleDraft.trim() || agent.title,
        });
      }

      await queryClient.refetchQueries({
        queryKey: ["workspace-overview", workspaceData.workspace.id],
        exact: true,
      });
      setHomeThread({ kind: "agent", agentId: agent.id });
      setSelectedAgentId(agent.id);
      setActiveMenu(null);
      setRightSidebarTab("details");
      setRightSidebarVisible(false);
      setAgentTitleCreateDraft("");
      setAgentRoleDraft("");
      setAgentTaskDraft("");
      setSelectedContextPackIds([]);
      setWorkspaceNotice({
        tone: "success",
        text: launchImmediately
          ? `Created and launched ${agent.title}.`
          : `Created ${agent.title}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to create the agent.",
      });
    } finally {
      setAgentFlowPending(false);
    }
  }

  async function handleRequestPlannerSuggestion(): Promise<void> {
    if (!workspaceData || !canRequestPlannerSuggestion) {
      return;
    }

    const requestedAt = new Date().toISOString();
    const trimmedTask = plannerTaskDraft.trim();
    const trimmedConstraints = plannerConstraintsDraft.trim() || undefined;

    setWorkspaceNotice({
      tone: "info",
      text: `Requesting a fleet recommendation from ${plannerProviderDraft}/${plannerModelDraft.trim()}...`,
    });
    appendPlannerThreadEntries([
      {
        id: `planner-request-${requestedAt}`,
        ts: requestedAt,
        role: "user",
        provider: plannerProviderDraft,
        model: plannerModelDraft.trim(),
        task: trimmedTask,
        constraints: trimmedConstraints,
      },
    ]);

    try {
      const suggestion = await plannerSuggestionMutation.mutateAsync({
        workspaceId: workspaceData.workspace.id,
        provider: plannerProviderDraft,
        model: plannerModelDraft.trim(),
        task: trimmedTask,
        constraints: trimmedConstraints,
      });
      const coordinationBrief = buildCoordinationBriefFromPlanner({
        source: "planner",
        task: trimmedTask,
        constraints: trimmedConstraints,
        suggestion,
      });
      setPlannerSuggestionState(suggestion);
      setPlannerAgentDrafts(
        suggestion.agents.map((agent) => ({
          provider: agent.provider,
          model: agent.model,
        })),
      );
      appendPlannerThreadEntries([
        {
          id: `planner-response-${requestedAt}`,
          ts: new Date().toISOString(),
          role: "assistant",
          source: "live",
          suggestion,
        },
      ]);
      setActivePlannerHistoryEntryId(`planner-response-${requestedAt}`);
      try {
        await persistCoordinationBrief(coordinationBrief);
        setWorkspaceNotice({
          tone: "success",
          text: `${suggestion.advisorProvider}/${suggestion.advisorModel} recommended ${suggestion.recommendedAgentCount} agent${suggestion.recommendedAgentCount === 1 ? "" : "s"}.`,
        });
      } catch (persistError) {
        setWorkspaceNotice({
          tone: "error",
          text:
            persistError instanceof Error
              ? `Generated a recommendation, but failed to persist the coordination brief: ${persistError.message}`
              : "Generated a recommendation, but failed to persist the coordination brief.",
        });
      }
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to generate the planner recommendation.",
      });
    }
  }

  async function persistCoordinationBrief(
    coordinationBrief: CoordinationBriefRecord | null,
    successText?: string,
  ): Promise<void> {
    if (!workspaceData) {
      return;
    }

    await saveCoordinationBriefMutation.mutateAsync({
      workspaceId: workspaceData.workspace.id,
      coordinationBrief,
    });
    await queryClient.refetchQueries({
      queryKey: ["workspace-overview", workspaceData.workspace.id],
      exact: true,
    });

    if (successText) {
      setWorkspaceNotice({
        tone: "success",
        text: successText,
      });
    }
  }

  async function handleCreateSuggestedFleet(launchImmediately: boolean): Promise<void> {
    const suggestion = plannerSuggestionWithDrafts ?? plannerSuggestion;

    if (!workspaceData || !suggestion || suggestion.agents.length === 0) {
      return;
    }

    setPlannerFleetPending(true);
    setWorkspaceNotice({
      tone: "info",
      text: launchImmediately
        ? `Creating and launching ${suggestion.agents.length} suggested agents...`
        : `Creating ${suggestion.agents.length} suggested agents...`,
    });

    try {
      const createdAgents: AgentSessionRecord[] = [];

      for (const [index, recommendation] of suggestion.agents.entries()) {
        const agentDraft = plannerAgentDrafts[index] ?? {
          provider: recommendation.provider,
          model: recommendation.model,
        };
        const coordinationContext = await getRenderedCoordinationContext({
          role: recommendation.role,
          title: recommendation.role,
        });
        const taskWithPlannerGuidance = [
          recommendation.objective.trim(),
          coordinationContext,
        ]
          .filter(Boolean)
          .join("\n\n");
        const agent = await createAgentMutation.mutateAsync({
          workspaceId: workspaceData.workspace.id,
          provider: agentDraft.provider,
          model: agentDraft.model,
          title: recommendation.role,
          role: recommendation.role,
          task: taskWithPlannerGuidance,
          cwd: workspaceData.workspace.projectRoot || undefined,
        });
        createdAgents.push(agent);

        if (launchImmediately) {
          await createRunMutation.mutateAsync({
            agentId: agent.id,
            prompt: taskWithPlannerGuidance,
            title: recommendation.role,
          });
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["workspace-overview", workspaceData.workspace.id] });

      if (createdAgents.length > 0) {
        setHomeThread({ kind: "agent", agentId: createdAgents[0].id });
        setSelectedAgentId(createdAgents[0].id);
        setActiveMenu(null);
        setRightSidebarTab("details");
        setRightSidebarVisible(false);
      }

      setWorkspaceNotice({
        tone: "success",
        text: launchImmediately
          ? `Created and launched ${createdAgents.length} suggested agent${createdAgents.length === 1 ? "" : "s"}.`
          : `Created ${createdAgents.length} suggested agent${createdAgents.length === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to create the suggested agent fleet.",
      });
    } finally {
      setPlannerFleetPending(false);
    }
  }

  function handlePlannerAgentDraftChange(
    index: number,
    patch: Partial<{ provider: "codex" | "claude"; model: string }>,
  ): void {
    setPlannerAgentDrafts((current) =>
      current.map((draft, currentIndex) => (currentIndex === index ? { ...draft, ...patch } : draft)),
    );
  }

  async function handleSavePlannerRecommendation(): Promise<void> {
    const suggestion = plannerSuggestionWithDrafts ?? plannerSuggestion;

    if (!workspaceData || !suggestion) {
      return;
    }

    const savedRecord: SavedPlannerRecommendationRecord = {
      savedAt: new Date().toISOString(),
      workspaceId: workspaceData.workspace.id,
      task: plannerTaskDraft.trim(),
      constraints: plannerConstraintsDraft.trim() || undefined,
      suggestion,
    };

    const nextEntry = buildSavedPlannerBlock(savedRecord);
    const coordinationBrief = buildCoordinationBriefFromPlanner({
      source: "saved_recommendation",
      task: savedRecord.task,
      constraints: savedRecord.constraints,
      suggestion,
    });

    const nextSharedContext = workspaceData.workspace.sharedContext.trim()
      ? `${workspaceData.workspace.sharedContext.trimEnd()}\n\n${nextEntry}`
      : nextEntry;

    setPlannerSavePending(true);
    setWorkspaceNotice({
      tone: "info",
      text: "Saving planner recommendation into workspace shared context...",
    });

    try {
      await saveSharedContextMutation.mutateAsync({
        workspaceId: workspaceData.workspace.id,
        sharedContext: nextSharedContext,
      });
      await persistCoordinationBrief(coordinationBrief);
      setSharedContextDraft(nextSharedContext);
      setWorkspaceNotice({
        tone: "success",
        text: "Saved planner recommendation into workspace history and refreshed the active coordination brief.",
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to save the planner recommendation.",
      });
    } finally {
      setPlannerSavePending(false);
    }
  }

  async function handleLoadSavedPlannerRecommendation(): Promise<void> {
    if (!lastSavedPlannerRecommendation) {
      setWorkspaceNotice({
        tone: "error",
        text: "No saved planner recommendation was found in this workspace yet.",
      });
      return;
    }

    setPlannerProviderDraft(lastSavedPlannerRecommendation.suggestion.advisorProvider);
    setPlannerModelDraft(lastSavedPlannerRecommendation.suggestion.advisorModel);
    setPlannerTaskDraft(lastSavedPlannerRecommendation.task);
    setPlannerConstraintsDraft(lastSavedPlannerRecommendation.constraints ?? "");
    setPlannerSuggestionState(lastSavedPlannerRecommendation.suggestion);
    setPlannerAgentDrafts(
      lastSavedPlannerRecommendation.suggestion.agents.map((agent) => ({
        provider: agent.provider,
        model: agent.model,
      })),
    );
    setActivePlannerHistoryEntryId(`planner-saved-${lastSavedPlannerRecommendation.savedAt}`);
    appendPlannerThreadEntries([
      {
        id: `planner-saved-${lastSavedPlannerRecommendation.savedAt}`,
        ts: lastSavedPlannerRecommendation.savedAt,
        role: "assistant",
        source: "saved",
        suggestion: lastSavedPlannerRecommendation.suggestion,
      },
    ]);
    try {
      await persistCoordinationBrief(
        buildCoordinationBriefFromSavedRecommendation(lastSavedPlannerRecommendation),
        "Loaded the last saved planner recommendation from workspace history.",
      );
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text:
          error instanceof Error
            ? `Loaded the saved recommendation, but failed to persist the coordination brief: ${error.message}`
            : "Loaded the saved recommendation, but failed to persist the coordination brief.",
      });
    }
  }

  async function handleStartSelectedAgent(): Promise<void> {
    if (!selectedAgent) {
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Starting ${selectedAgent.title}...`,
    });

    try {
      await startSelectedAgentMutation.mutateAsync(selectedAgent.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-events", selectedAgent.id] }),
      ]);
      setWorkspaceNotice({
        tone: "success",
        text: `${selectedAgent.title} is ready for input.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to start the agent.",
      });
    }
  }

  async function handleInterruptSelectedAgent(): Promise<void> {
    if (!selectedAgent) {
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Interrupting ${selectedAgent.title}...`,
    });

    try {
      await interruptSelectedAgentMutation.mutateAsync(selectedAgent.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-events", selectedAgent.id] }),
      ]);
      setWorkspaceNotice({
        tone: "success",
        text: `Interrupted ${selectedAgent.title}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to interrupt the agent.",
      });
    }
  }

  async function handleStopSelectedAgent(): Promise<void> {
    if (!selectedAgent) {
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Stopping ${selectedAgent.title}...`,
    });

    try {
      await stopSelectedAgentMutation.mutateAsync(selectedAgent.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-events", selectedAgent.id] }),
      ]);
      setWorkspaceNotice({
        tone: "success",
        text: `Stopped ${selectedAgent.title}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to stop the agent.",
      });
    }
  }

  async function handleStopAgentById(agentId: string): Promise<void> {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Stopping ${agent.title}...`,
    });

    try {
      await stopSelectedAgentMutation.mutateAsync(agentId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-events", agentId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-runs", agentId] }),
      ]);
      setWorkspaceNotice({
        tone: "success",
        text: `Stopped ${agent.title}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : `Failed to stop ${agent.title}.`,
      });
    }
  }

  async function handleStopAgents(scope: "visible" | "all" | "running"): Promise<void> {
    const sourceAgents =
      scope === "all"
        ? agents
        : scope === "running"
          ? runningAgents
          : visibleTiles;
    const stoppableAgents = sourceAgents.filter((agent) => !["STOPPED", "COMPLETED"].includes(agent.state));

    if (stoppableAgents.length === 0) {
      setWorkspaceNotice({
        tone: "info",
        text:
          scope === "running"
            ? "There are no currently running agents to stop."
            : `There are no ${scope} agents to stop.`,
      });
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Stopping ${scope} agents (${stoppableAgents.length})...`,
    });

    let stopped = 0;
    let failed = 0;

    for (const agent of stoppableAgents) {
      try {
        await stopSelectedAgentMutation.mutateAsync(agent.id);
        stopped += 1;
      } catch {
        failed += 1;
      }
    }

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
      ...stoppableAgents.flatMap((agent) => [
        queryClient.invalidateQueries({ queryKey: ["agent-events", agent.id] }),
        queryClient.invalidateQueries({ queryKey: ["agent-runs", agent.id] }),
      ]),
    ]);

    if (failed > 0) {
      setWorkspaceNotice({
        tone: "error",
        text: `Stopped ${stopped} of ${stoppableAgents.length} ${scope} agents. ${failed} could not be stopped.`,
      });
      return;
    }

    setWorkspaceNotice({
      tone: "success",
      text: `Stopped ${stopped} ${scope} agent${stopped === 1 ? "" : "s"}.`,
    });
  }

  async function handleStopSelectedRun(): Promise<void> {
    if (!selectedRun) {
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Stopping run ${selectedRun.title}...`,
    });

    try {
      await stopRunMutation.mutateAsync(selectedRun.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-runs", selectedRun.agentId] }),
        queryClient.invalidateQueries({ queryKey: ["run-transcript", selectedRun.id] }),
        queryClient.invalidateQueries({ queryKey: ["run-tool-calls", selectedRun.id] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
      ]);
      setWorkspaceNotice({
        tone: "success",
        text: `Stopped run ${selectedRun.title}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to stop the run.",
      });
    }
  }

  async function handleApprove(approvalId: string): Promise<void> {
    try {
      await approveApprovalMutation.mutateAsync({ approvalId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pending-approvals", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-inbox", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-runs", selectedAgentId] }),
        queryClient.invalidateQueries({ queryKey: ["run-transcript", selectedRunId] }),
        queryClient.invalidateQueries({ queryKey: ["run-tool-calls", selectedRunId] }),
      ]);
      setWorkspaceNotice({
        tone: "success",
        text: "Approved the pending tool request.",
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to approve the request.",
      });
    }
  }

  async function handleDeny(approvalId: string): Promise<void> {
    try {
      await denyApprovalMutation.mutateAsync({ approvalId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pending-approvals", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-inbox", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-runs", selectedAgentId] }),
        queryClient.invalidateQueries({ queryKey: ["run-transcript", selectedRunId] }),
        queryClient.invalidateQueries({ queryKey: ["run-tool-calls", selectedRunId] }),
      ]);
      setWorkspaceNotice({
        tone: "success",
        text: "Denied the pending tool request.",
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to deny the request.",
      });
    }
  }

  async function handleResetSelectedWorktree(): Promise<void> {
    if (!selectedAgent) {
      return;
    }

    setWorkspaceNotice({
      tone: "info",
      text: `Resetting ${selectedAgent.title}'s worktree...`,
    });

    try {
      await resetWorktreeMutation.mutateAsync(selectedAgent.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-project-tree"] }),
      ]);
      setWorkspaceNotice({
        tone: "success",
        text: `Reset ${selectedAgent.title}'s worktree back to workspace HEAD.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to reset the worktree.",
      });
    }
  }

  function focusRun(agentId: string, runId: string): void {
    openSelectedAgentPage(agentId);
    setSelectedRunId(runId);
  }

  function focusFleetActivityItem(item: FleetActivityItem): void {
    if (item.runId) {
      focusRun(item.agentId, item.runId);
      return;
    }

    openSelectedAgentPage(item.agentId);
  }

  function selectHomeThread(nextThread: HomeThread): void {
    setActiveMenu(null);
    setHomeThread(nextThread);
    if (nextThread.kind === "workspace") {
      setRightSidebarTab("files");
      setWorkspaceFocusedAgentId("");
      setRightSidebarVisible(true);
    } else if (nextThread.kind === "planner") {
      setRightSidebarVisible(false);
      setWorkspaceFocusedAgentId("");
    } else {
      setRightSidebarVisible(true);
      setWorkspaceFocusedAgentId("");
    }
  }

  function selectAgentThread(agentId: string): void {
    openSelectedAgentPage(agentId);
  }

  function focusWorkspaceAgent(agentId: string): void {
    const latestActivity = latestFleetActivityByAgent.get(agentId);
    setActiveMenu(null);
    setHomeThread({ kind: "workspace" });
    setSelectedAgentId(agentId);
    setWorkspaceFocusedAgentId(agentId);
    setWorkspaceThreadTab("conversation");
    setSelectedRunId(latestActivity?.runId ?? "");
    setInspectorTab("session");
    setRightSidebarVisible(false);
  }

  function focusWorkspaceActivityItem(item: FleetActivityItem): void {
    setActiveMenu(null);
    setHomeThread({ kind: "workspace" });
    setSelectedAgentId(item.agentId);
    setWorkspaceFocusedAgentId(item.agentId);
    setWorkspaceThreadTab("conversation");
    setSelectedRunId(item.runId ?? "");
    setInspectorTab("session");
    setRightSidebarVisible(false);
  }

  function openSelectedAgentPage(agentId: string): void {
    setActiveMenu(null);
    const latestActivity = latestFleetActivityByAgent.get(agentId);
    setHomeThread({ kind: "agent", agentId });
    setSelectedAgentId(agentId);
    setWorkspaceFocusedAgentId(agentId);
    setSelectedRunId(latestActivity?.runId ?? "");
    setInspectorTab("session");
    setRightSidebarTab("details");
    setRightSidebarVisible(false);
  }

  function clearWorkspaceAgentFocus(): void {
    setWorkspaceFocusedAgentId("");
    setSelectedRunId("");
    setHomeThread({ kind: "workspace" });
    setWorkspaceThreadTab("conversation");
  }

  function scrollWorkspaceConversationToLatest(behavior: ScrollBehavior = "smooth"): void {
    const container = workspaceConversationStreamRef.current;
    if (!container) {
      return;
    }

    // Mark as programmatic so the scroll listener doesn't flip workspaceShouldAutoScrollRef
    // to false while a smooth-scroll animation is in progress.
    workspaceIsProgrammaticScrollRef.current = true;
    window.setTimeout(
      () => { workspaceIsProgrammaticScrollRef.current = false; },
      behavior === "smooth" ? 600 : 50,
    );

    // Use a large top value so the browser clamps to the true bottom even if scrollHeight
    // hasn't fully settled after a content update (avoids "half way" scrolling).
    container.scrollTo({
      top: 999_999,
      behavior,
    });
  }

  async function handleCreateAgentFromInbox(handoffId: string): Promise<void> {
    try {
      const agent = await createAgentFromHandoffMutation.mutateAsync(handoffId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-inbox", activeWorkspaceId] }),
      ]);
      setActiveMenu(null);
      setSelectedAgentId(agent.id);
      setWorkspaceNotice({
        tone: "success",
        text: `Created ${agent.title} from the handoff inbox.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to create an agent from the handoff.",
      });
    }
  }

  async function handleAssignInbox(handoffId: string, agentId: string): Promise<void> {
    try {
      await assignHandoffMutation.mutateAsync({ handoffId, agentId });
      await queryClient.invalidateQueries({ queryKey: ["workspace-inbox", activeWorkspaceId] });
      setWorkspaceNotice({
        tone: "success",
        text: "Assigned the handoff to the selected agent.",
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to assign the handoff.",
      });
    }
  }

  async function handleUpdateInboxStatus(handoffId: string, status: HandoffItemRecord["status"]): Promise<void> {
    try {
      await updateHandoffStatusMutation.mutateAsync({ handoffId, status });
      await queryClient.invalidateQueries({ queryKey: ["workspace-inbox", activeWorkspaceId] });
      setWorkspaceNotice({
        tone: "success",
        text: `Marked the handoff as ${status.toLowerCase()}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to update the handoff.",
      });
    }
  }

  async function handleSaveProviderSettings(): Promise<void> {
    if (!hasPendingSettingsChanges) {
      return;
    }

    await providerSettingsMutation.mutateAsync({
      openaiApiKey: openaiApiKey.trim() || undefined,
      anthropicApiKey: anthropicApiKey.trim() || undefined,
      coordinationApiKey: coordinationApiKey.trim() || undefined,
    });
    setCoordinationApiKey("");
  }

  async function handleClearProviderSettings(provider: "openai" | "anthropic" | "coordination"): Promise<void> {
    await providerSettingsMutation.mutateAsync({
      clearOpenai: provider === "openai",
      clearAnthropic: provider === "anthropic",
      clearCoordination: provider === "coordination",
    });
  }

  function openHomeWithFilter(nextFilter: FilterId): void {
    setActiveMenu(null);
    setHomeThread({ kind: "workspace" });
    setWorkspaceFocusedAgentId("");
    setFilter(nextFilter);
  }

  async function getRenderedCoordinationContext(options?: {
    agentId?: string;
    role?: string;
    title?: string;
  }): Promise<string> {
    if (!workspaceData) {
      return "";
    }

    try {
      const packet = await fetchRenderedCoordinationPacket(workspaceData.workspace.id, options);
      return packet?.content?.trim() ?? "";
    } catch (error) {
      console.warn("Failed to render coordination packet from control plane.", error);
      return "";
    }
  }

  async function dispatchInstruction(agentId: string, input: string): Promise<AgentRunRecord> {
    const coordinationContext = await getRenderedCoordinationContext({ agentId });
    const run = await createRunMutation.mutateAsync({
      agentId,
      prompt: [input.trim(), coordinationContext].filter(Boolean).join("\n\n"),
    });
    return run;
  }

  async function handleSendToSelectedAgent(): Promise<void> {
    if (!selectedAgent || !canSendAgentInput) {
      return;
    }

    const message = agentInputDraft.trim();
    const startedAt = new Date().toISOString();
    setHomeThread({ kind: "agent", agentId: selectedAgent.id });
    setAgentMessagePending(true);
    setWorkspaceNotice({
      tone: "info",
      text: `Sending instruction to ${selectedAgent.title}...`,
    });
    appendFleetActivity([
      {
        id: `manual-run-${selectedAgent.id}-${startedAt}`,
        agentId: selectedAgent.id,
        agentTitle: selectedAgent.title,
        ts: startedAt,
        summary: "Run requested",
        detail: truncateText(message, 180),
        tone: "info",
        source: "broadcast",
      },
    ]);
    setPendingRunRequests((current) => ({
      ...current,
      [selectedAgent.id]: {
        ts: startedAt,
        prompt: message,
      },
    }));

    try {
      const run = await dispatchInstruction(selectedAgent.id, message);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["agent-events", selectedAgent.id] }),
        queryClient.invalidateQueries({ queryKey: ["agent-runs", selectedAgent.id] }),
        queryClient.invalidateQueries({ queryKey: ["pending-approvals", activeWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-inbox", activeWorkspaceId] }),
      ]);
      setSelectedRunId(run.id);
      setPendingRunRequests((current) => ({
        ...current,
        [selectedAgent.id]: {
          ts: startedAt,
          prompt: message,
          runId: run.id,
        },
      }));
      setAgentInputDraft("");
      setWorkspaceNotice({
        tone: "success",
        text: `Started a tracked run for ${selectedAgent.title}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to send the instruction.",
      });
    } finally {
      setAgentMessagePending(false);
    }
  }

  async function submitWorkspaceInstruction(
    targetAgents: AgentSessionRecord[],
    message: string,
    scope: WorkspaceThreadEntry["scope"],
    options?: {
      agentId?: string;
      title?: string;
      clearComposer?: boolean;
      inlineReplyAgentId?: string;
    },
  ): Promise<void> {
    if (!message.trim() || targetAgents.length === 0) {
      return;
    }

    const queuedAt = new Date().toISOString();
    const title =
      options?.title ??
      (scope === "agent" && targetAgents[0]
        ? `Message to ${targetAgents[0].title}`
        : "Workspace instruction");

    setHomeThread({ kind: "workspace" });
    setWorkspaceThreadEntries((current) =>
      [
        ...current,
        {
          id: `workspace-prompt-${queuedAt}`,
          ts: queuedAt,
          role: "user" as const,
          title,
          content: message,
          scope,
          agentId: options?.agentId,
          targetAgentIds: targetAgents.map((agent) => agent.id),
        },
      ].slice(-80),
    );
    setBroadcastPending(true);
    workspaceShouldAutoScrollRef.current = true;
    workspaceScrollHeightRef.current = 0; // reset so the new content triggers auto-scroll
    setWorkspaceNotice({
      tone: "info",
      text: `Sending to ${targetAgents.length} agent${targetAgents.length === 1 ? "" : "s"}...`,
    });
    appendFleetActivity(
      targetAgents.map((agent) => ({
        id: `broadcast-queued-${queuedAt}-${agent.id}`,
        agentId: agent.id,
        agentTitle: agent.title,
        ts: queuedAt,
        summary: "Broadcast queued",
        detail: truncateText(message, 180),
        tone: "info",
        source: "broadcast",
      })),
    );
    setPendingRunRequests((current) => ({
      ...current,
      ...Object.fromEntries(
        targetAgents.map((agent) => [
          agent.id,
          {
            ts: queuedAt,
            prompt: message,
          },
        ]),
      ),
    }));

    try {
      const dispatchedRuns: AgentRunRecord[] = [];

      if (scope !== "agent") {
        // Workspace-wide instruction: let the coordinator dispatch
        const result = await dispatchWorkspaceReply(activeWorkspaceId, {
          replyText: message,
          promptId: `workspace-prompt-${queuedAt}`,
          teamAskId: activeWorkspaceTeamAsk?.id,
        });

        if (result.status === "dispatched") {
          // Build synthetic AgentRunRecord stubs so the rest of the flow can proceed
          for (const runId of result.dispatchedRunIds) {
            dispatchedRuns.push({ id: runId } as AgentRunRecord);
          }
        } else if (result.status === "all_blocked") {
          setWorkspaceNotice({ tone: "info", text: "All agents are waiting on dependencies. Reply queued." });
          return;
        } else if (result.status === "no_agents") {
          setWorkspaceNotice({ tone: "error", text: "No eligible agents to receive this reply." });
          return;
        } else {
          // stale_state: fall back to direct broadcast
          for (const agent of targetAgents) {
            try {
              const run = await dispatchInstruction(agent.id, message);
              dispatchedRuns.push(run);
            } catch {
              // individual failure handled below via activity log
            }
          }
          console.warn("Coordinator state stale; used direct broadcast fallback");
        }
      } else {
        // Focused-agent message: direct path, coordinator not involved
        for (const agent of targetAgents) {
          try {
            const run = await dispatchInstruction(agent.id, message);
            dispatchedRuns.push(run);
          } catch {
            // individual failure handled below via activity log
          }
        }
      }

      const results: PromiseSettledResult<AgentRunRecord>[] = targetAgents.map((agent, index) => {
        const matchedRun = dispatchedRuns[index];
        if (matchedRun) {
          return { status: "fulfilled", value: matchedRun };
        }
        return { status: "rejected", reason: new Error("Run not dispatched") };
      });

      const failed = results.filter((result) => result.status === "rejected").length;
      const settledAt = new Date().toISOString();
      appendFleetActivity(
        results.map((result, index) => {
          const agent = targetAgents[index];

          if (result.status === "fulfilled") {
            return {
              id: `broadcast-started-${settledAt}-${agent.id}`,
              agentId: agent.id,
              agentTitle: agent.title,
              ts: settledAt,
              summary: "Run requested",
              detail: truncateText(message, 180),
              tone: "success" as const,
              source: "broadcast" as const,
              runId: result.value.id,
            };
          }

          return {
            id: `broadcast-failed-${settledAt}-${agent.id}`,
            agentId: agent.id,
            agentTitle: agent.title,
            ts: settledAt,
            summary: "Broadcast failed",
            detail: "The run request did not reach this agent.",
            tone: "danger" as const,
            source: "broadcast" as const,
          };
        }),
      );

      if (scope === "agent" && targetAgents.length === 1) {
        const firstSuccessful = results.find(
          (result): result is PromiseFulfilledResult<AgentRunRecord> => result.status === "fulfilled",
        );
        if (firstSuccessful) {
          const focusAgent = targetAgents[0];
          setSelectedAgentId(focusAgent.id);
          setSelectedRunId(firstSuccessful.value.id);
          if (workspaceFocusedAgentId) {
            setWorkspaceFocusedAgentId(focusAgent.id);
          }
        }
      }

      setPendingRunRequests((current) => {
        const next = { ...current };

        results.forEach((result, index) => {
          const agent = targetAgents[index];

          if (result.status === "fulfilled") {
            next[agent.id] = {
              ts: settledAt,
              prompt: message,
              runId: result.value.id,
            };
            return;
          }

          delete next[agent.id];
        });

        return next;
      });

      await queryClient.invalidateQueries({ queryKey: ["workspace-overview", activeWorkspaceId] });
      await Promise.all(
        targetAgents.flatMap((agent) => [
          queryClient.invalidateQueries({ queryKey: ["agent-events", agent.id] }),
          queryClient.invalidateQueries({ queryKey: ["agent-runs", agent.id] }),
        ]),
      );
      await queryClient.invalidateQueries({ queryKey: ["pending-approvals", activeWorkspaceId] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-inbox", activeWorkspaceId] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-events", activeWorkspaceId] });

      if (options?.clearComposer) {
        setBroadcastInputDraft("");
      }
      if (options?.inlineReplyAgentId) {
        setInlineAgentReplyDrafts((current) => ({
          ...current,
          [options.inlineReplyAgentId!]: "",
        }));
      }

      if (failed > 0) {
        setWorkspaceNotice({
          tone: "error",
          text: `Broadcast reached ${targetAgents.length - failed} of ${targetAgents.length} agents.`,
        });
      } else {
        setWorkspaceNotice({
          tone: "success",
          text: `Sent to ${targetAgents.length} agent${targetAgents.length === 1 ? "" : "s"}.`,
        });
      }
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to send the instruction.",
      });
    } finally {
      setBroadcastPending(false);
    }
  }

  async function handleBroadcast(): Promise<void> {
    const message = broadcastInputDraft.trim();
    const targetAgents = workspaceComposerTargetAgents;

    if (!message || targetAgents.length === 0) {
      return;
    }

    const isTeamReply = !workspaceFocusedAgent && Boolean(activeWorkspaceTeamAsk);
    await submitWorkspaceInstruction(targetAgents, message, workspaceFocusedAgent ? "agent" : "visible", {
      agentId: workspaceFocusedAgent?.id,
      title: workspaceFocusedAgent
        ? `Message to ${workspaceFocusedAgent.title}`
        : isTeamReply
          ? "Reply to team ask"
          : "Workspace instruction",
      clearComposer: true,
    });
  }

  async function handleInlineWorkspaceReply(agentId: string): Promise<void> {
    const draft = inlineAgentReplyDrafts[agentId]?.trim() ?? "";
    const agent = agents.find((candidate) => candidate.id === agentId) ?? null;

    if (!agent || !draft) {
      return;
    }

    await submitWorkspaceInstruction([agent], draft, "agent", {
      agentId,
      title: `Reply to ${agent.title}`,
      inlineReplyAgentId: agentId,
    });
  }

  async function handleRunTerminal(): Promise<void> {
    if (!workspaceData || !terminalCommandDraft.trim()) {
      return;
    }

    const cwd =
      selectedAgent?.worktree?.path ||
      (selectedAgent?.metadata.cwd as string | undefined) ||
      workspaceData.workspace.projectRoot;

    if (!cwd) {
      setWorkspaceNotice({
        tone: "error",
        text: "Set a project root before running terminal commands.",
      });
      return;
    }

    setTerminalPending(true);

    try {
      const result = await runTerminalCommand({
        cwd,
        command: terminalCommandDraft.trim(),
        allowedRoots: workspaceData?.workspace.projectRoot ? [workspaceData.workspace.projectRoot] : undefined,
      });
      setTerminalHistory((current) => [result, ...current].slice(0, 24));
      setTerminalCommandDraft("");
      setWorkspaceNotice({
        tone: result.exitCode === 0 ? "success" : "error",
        text:
          result.exitCode === 0
            ? `Ran terminal command in ${cwd}.`
            : `Command exited with code ${result.exitCode}.`,
      });
      setRightSidebarTab("terminal");
      setRightSidebarVisible(true);
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to run the terminal command.",
      });
    } finally {
      setTerminalPending(false);
    }
  }

  function navigateExplorer(path: string): void {
    const normalizedTarget = normalizePathString(path);

    if (!normalizedTarget) {
      return;
    }

    if (explorerBoundaryRoot && !isPathInsideRoot(explorerBoundaryRoot, normalizedTarget)) {
      setWorkspaceNotice({
        tone: "error",
        text: `Explorer navigation must stay inside ${explorerBoundaryRoot}.`,
      });
      return;
    }

    setExplorerRootOverride(normalizedTarget === explorerBoundaryRoot ? "" : normalizedTarget);
    setExplorerLocationDraft(normalizedTarget);
    setExplorerSearchDraft("");
    setExpandedExplorerPaths([]);
    setSelectedExplorerFilePath("");
    setSelectedExplorerContent("");
    setSelectedExplorerTruncated(false);
  }

  function toggleExplorerExpanded(path: string): void {
    setExpandedExplorerPaths((current) =>
      current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path],
    );
  }

  function handleExplorerNavigate(): void {
    const input = explorerLocationDraft.trim();

    if (!input) {
      navigateExplorer(explorerBoundaryRoot || defaultExplorerRoot);
      return;
    }

    const nextPath = input.startsWith("/")
      ? normalizePathString(input)
      : joinPath(explorerRoot || explorerBoundaryRoot || "/", input);

    navigateExplorer(nextPath);
  }

  function handleExplorerNavigateUp(): void {
    const currentRoot = normalizePathString(explorerRoot);
    const nextPath = getParentPath(currentRoot);

    if (explorerBoundaryRoot && !isPathInsideRoot(explorerBoundaryRoot, nextPath)) {
      navigateExplorer(explorerBoundaryRoot);
      return;
    }

    navigateExplorer(nextPath);
  }

  function handleExplorerReset(): void {
    navigateExplorer(explorerBoundaryRoot || defaultExplorerRoot);
  }

  async function handleSaveExplorerFile(): Promise<void> {
    if (!selectedExplorerFilePath || !canEditExplorerFile) {
      return;
    }

    setFileSavePending(true);

    try {
      const preview = await writeProjectFile(
        selectedExplorerFilePath,
        selectedExplorerContent,
        workspaceData?.workspace.projectRoot ? [workspaceData.workspace.projectRoot] : undefined,
      );
      setSelectedExplorerContent(preview.content);
      setSelectedExplorerLoadedContent(preview.content);
      setSelectedExplorerTruncated(preview.truncated);
      setWorkspaceNotice({
        tone: "success",
        text: `Saved ${selectedExplorerDisplayPath || selectedExplorerFilePath}.`,
      });
    } catch (error) {
      setWorkspaceNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to save the selected file.",
      });
    } finally {
      setFileSavePending(false);
    }
  }

  function handleRevertExplorerFile(): void {
    setSelectedExplorerContent(selectedExplorerLoadedContent);
  }

  const commandPaletteActions = useMemo<CommandPaletteAction[]>(() => {
    const actions: CommandPaletteAction[] = [
      { id: "nav-home", label: "Go to Workspace thread", run: () => selectHomeThread({ kind: "workspace" }) },
      { id: "nav-planner", label: "Open Planner thread", run: () => selectHomeThread({ kind: "planner" }) },
      { id: "nav-inbox", label: "Open Inbox thread", run: () => selectHomeThread({ kind: "inbox" }) },
      {
        id: "nav-providers",
        label: "Open provider settings",
        run: () => {
          setSettingsDrawerTab("providers");
          setActiveMenu("settings");
        },
      },
      {
        id: "nav-runtime",
        label: "Open runtime settings",
        run: () => {
          setSettingsDrawerTab("runtime");
          setActiveMenu("settings");
        },
      },
      { id: "home-errors", label: "Show errored agents", hint: "Home", run: () => openHomeWithFilter("errors") },
      { id: "home-active", label: "Show active agents", hint: "Home", run: () => openHomeWithFilter("active") },
      {
        id: "panel-files",
        label: "Open files sidebar",
        hint: "Panel",
        run: () => {
          setActiveMenu(null);
          setRightSidebarTab("files");
          setRightSidebarVisible(true);
        },
      },
      {
        id: "panel-terminal",
        label: "Open terminal panel",
        hint: "Panel",
        run: () => {
          setActiveMenu(null);
          setRightSidebarTab("terminal");
          setRightSidebarVisible(true);
        },
      },
      {
        id: "panel-artifacts",
        label: "Open artifacts panel",
        hint: "Panel",
        run: () => {
          setActiveMenu(null);
          setRightSidebarTab("artifacts");
          setRightSidebarVisible(true);
        },
      },
      {
        id: "refresh-workspace",
        label: "Refresh workspace snapshot",
        hint: "Workspace",
        run: () => {
          void workspaceOverviewQuery.refetch();
        },
      },
    ];

    if (workspaceData) {
      actions.push(
        {
          id: "workspace-save",
          label: "Save workspace settings",
          hint: "Workspace",
          run: () => {
            void handleRenameWorkspace();
          },
        },
        {
          id: "workspace-sidebar",
          label: "Open workspace popover",
          hint: "Workspace",
          run: () => {
            setActiveMenu(null);
            setWorkspaceSettingsPopoverOpen(true);
          },
        },
        {
          id: "workspace-new-agent",
          label: "Start creating an agent",
          hint: "Workspace",
          run: () => {
            setActiveMenu(null);
            setSelectedAgentId("");
            setSelectedRunId("");
            setRightSidebarTab("details");
            setHomeThread({ kind: "workspace" });
          },
        },
        {
          id: "workspace-seed-demo",
          label: "Seed demo board",
          hint: "Workspace",
          run: () => {
            void handleSeedDemoBoard();
          },
        },
      );
    }

    if (lastSavedPlannerRecommendation) {
      actions.push({
        id: "planner-load-last",
        label: "Load last saved planner recommendation",
        hint: "Planner",
        run: () => {
          setActiveMenu(null);
          setHomeThread({ kind: "planner" });
          setRightSidebarVisible(false);
          void handleLoadSavedPlannerRecommendation();
        },
      });
    }

    if (selectedAgent) {
      actions.push(
        {
          id: "agent-focus",
          label: `Focus ${selectedAgent.title}`,
          hint: "Inspector",
          run: () => {
            selectAgentThread(selectedAgent.id);
          },
        },
        {
          id: "agent-start",
          label: `Start ${selectedAgent.title}`,
          hint: "Agent ops",
          run: () => {
            void handleStartSelectedAgent();
          },
        },
        {
          id: "agent-interrupt",
          label: `Interrupt ${selectedAgent.title}`,
          hint: "Agent ops",
          run: () => {
            void handleInterruptSelectedAgent();
          },
        },
        {
          id: "agent-stop",
          label: `Stop ${selectedAgent.title}`,
          hint: "Agent ops",
          run: () => {
            void handleStopSelectedAgent();
          },
        },
        {
          id: "agent-reset-worktree",
          label: `Reset ${selectedAgent.title} worktree`,
          hint: "Agent ops",
          run: () => {
            void handleResetSelectedWorktree();
          },
        },
      );
    }

    if (selectedRun) {
      actions.push({
        id: "run-stop",
        label: `Stop run ${selectedRun.title}`,
        hint: "Run",
        run: () => {
          void handleStopSelectedRun();
        },
      });
    }

    if (selectedRunApprovals[0]) {
      actions.push(
        {
          id: "approval-approve",
          label: `Approve ${selectedRunApprovals[0].requestedAction}`,
          hint: "Approval",
          run: () => {
            void handleApprove(selectedRunApprovals[0].id);
          },
        },
        {
          id: "approval-deny",
          label: `Deny ${selectedRunApprovals[0].requestedAction}`,
          hint: "Approval",
          run: () => {
            void handleDeny(selectedRunApprovals[0].id);
          },
        },
      );
    }

    return actions;
  }, [
    lastSavedPlannerRecommendation,
    openHomeWithFilter,
    selectedAgent,
    selectedRun,
    selectedRunApprovals,
    workspaceData,
    workspaceOverviewQuery,
  ]);

  const filteredCommandPaletteActions = useMemo(() => {
    const query = commandPaletteQuery.trim().toLowerCase();

    if (!query) {
      return commandPaletteActions;
    }

    return commandPaletteActions.filter((action) =>
      `${action.label} ${action.hint ?? ""}`.toLowerCase().includes(query),
    );
  }, [commandPaletteActions, commandPaletteQuery]);

  async function handleRunPaletteAction(action: CommandPaletteAction): Promise<void> {
    setCommandPaletteOpen(false);
    setCommandPaletteQuery("");
    await action.run();
  }

  function syncWorkspaceSettingsPopoverPosition(): void {
    const button = workspaceSettingsButtonRef.current;
    if (!button || typeof window === "undefined") {
      return;
    }

    const rect = button.getBoundingClientRect();
    const width = Math.min(360, Math.round(window.innerWidth * 0.78));
    const left = Math.max(16, Math.min(window.innerWidth - width - 16, rect.right - width));
    const top = Math.min(window.innerHeight - 24, rect.bottom + 8);

    setWorkspaceSettingsPopoverPosition({
      top,
      left,
      width,
    });
  }

  function renderWorkspaceMenu(): JSX.Element {
    return (
      <section className="menu-panel">
        <div>
          <span className="panel-kicker">Workspace</span>
          <h2>Workspace controls</h2>
          <p>Create, seed, or remove workspaces. Current workspace settings now live on Home.</p>
        </div>
        <div className="menu-stack">
          <section className="menu-section">
            <div>
              <span className="panel-kicker">Create</span>
              <h3>New workspace</h3>
            </div>
            <label className="settings-field">
              <span>Name</span>
              <input
                type="text"
                value={newWorkspaceDraft}
                onChange={(event) => setNewWorkspaceDraft(event.target.value)}
                placeholder="Agent Command Center"
              />
            </label>
            <label className="settings-field">
              <span>Project root</span>
              <input
                type="text"
                value={newWorkspaceProjectRootDraft}
                onChange={(event) => setNewWorkspaceProjectRootDraft(event.target.value)}
                placeholder="/absolute/path/to/repo"
              />
            </label>
            <div className="settings-actions">
              <button className="outline-button" onClick={() => void handleCreateWorkspace(false)} type="button">
                {createWorkspaceMutation.isPending && !bootstrapDemoMutation.isPending
                  ? "Creating..."
                  : "Create workspace"}
              </button>
              <button
                className="outline-button"
                disabled={createWorkspaceMutation.isPending || bootstrapDemoMutation.isPending}
                onClick={() => void handleCreateWorkspace(true)}
                type="button"
              >
                {createWorkspaceMutation.isPending || bootstrapDemoMutation.isPending
                  ? "Launching demo..."
                  : "Create with demo"}
              </button>
            </div>
          </section>

          <section className="menu-section">
            <div>
              <span className="panel-kicker">Selected workspace</span>
              <h3>{workspaceData ? workspaceData.workspace.name : "No workspace selected"}</h3>
            </div>
            {workspaceData ? (
              <>
                <p className="menu-muted-copy">
                  Use Home to edit the active workspace name and project root. This screen keeps the destructive
                  actions together.
                </p>
                <div className="settings-actions">
                  <button
                    className="outline-button"
                    disabled={bootstrapDemoMutation.isPending || workspaceHasContent}
                    onClick={() => void handleSeedDemoBoard()}
                    type="button"
                  >
                    {bootstrapDemoMutation.isPending
                      ? "Loading demo..."
                      : workspaceHasContent
                        ? "Demo already loaded"
                        : "Load demo here"}
                  </button>
                  <button
                    className="outline-button danger-button"
                    disabled={deleteWorkspaceMutation.isPending}
                    onClick={() => void handleDeleteWorkspace()}
                    type="button"
                  >
                    {deleteWorkspaceMutation.isPending
                      ? "Deleting..."
                      : deleteWorkspaceArmed
                        ? "Confirm delete"
                        : "Delete workspace"}
                  </button>
                  {deleteWorkspaceArmed ? (
                    <button
                      className="chip"
                      onClick={() => {
                        setDeleteWorkspaceArmed(false);
                        setWorkspaceNotice(null);
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <p>Select a workspace from the header to rename, seed, or delete it.</p>
            )}
          </section>
        </div>
      </section>
    );
  }

  function renderPlannerMenu(): JSX.Element {
    return (
      <section className="menu-panel">
        <div>
          <span className="panel-kicker">Planner</span>
          <h2>Fleet recommendation</h2>
          <p>Use one model to size the team, tune each agent, and turn the recommendation into a runnable fleet.</p>
        </div>
        {workspaceData ? (
          <div className="planner-layout">
            <div className="menu-stack">
              <section className="menu-section">
                <div>
                  <span className="panel-kicker">Advisor model</span>
                  <h3>Task planner</h3>
                </div>
                <div className="settings-status compact-row">
                  <span className="compact-note">workspace {workspaceData.workspace.name}</span>
                  <span className="compact-note">
                    {lastSavedPlannerRecommendation ? "saved recommendation available" : "no saved recommendation yet"}
                  </span>
                </div>
                <div className="menu-form-grid">
                  <label className="settings-field">
                    <span>Provider</span>
                    <select
                      className="workspace-picker"
                      value={plannerProviderDraft}
                      onChange={(event) => {
                        const nextProvider = event.target.value as "codex" | "claude";
                        setPlannerProviderDraft(nextProvider);
                        setPlannerModelDraft(defaultModelForProvider(nextProvider));
                      }}
                    >
                      <option value="codex">Codex</option>
                      <option value="claude">Claude</option>
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>Model</span>
                    <input
                      type="text"
                      value={plannerModelDraft}
                      onChange={(event) => setPlannerModelDraft(event.target.value)}
                      placeholder={defaultModelForProvider(plannerProviderDraft)}
                    />
                  </label>
                </div>
                <label className="settings-field">
                  <span>Task to plan</span>
                  <textarea
                    className="settings-textarea"
                    value={plannerTaskDraft}
                    onChange={(event) => setPlannerTaskDraft(event.target.value)}
                    placeholder="Describe the work and what a successful outcome looks like."
                    rows={7}
                  />
                </label>
                <label className="settings-field">
                  <span>Constraints</span>
                  <textarea
                    className="settings-textarea"
                    value={plannerConstraintsDraft}
                    onChange={(event) => setPlannerConstraintsDraft(event.target.value)}
                    placeholder="Optional: budget, time pressure, preferred providers, code ownership boundaries..."
                    rows={5}
                  />
                </label>
                <div className="settings-actions">
                  <button
                    className="outline-button"
                    disabled={!canRequestPlannerSuggestion || plannerSuggestionMutation.isPending}
                    onClick={() => void handleRequestPlannerSuggestion()}
                    type="button"
                  >
                    {plannerSuggestionMutation.isPending ? "Thinking..." : "Suggest agent fleet"}
                  </button>
                  <button
                    className="chip"
                    disabled={!lastSavedPlannerRecommendation}
                    onClick={() => void handleLoadSavedPlannerRecommendation()}
                    type="button"
                  >
                    Load last saved recommendation
                  </button>
                </div>
              </section>
            </div>

            <div className="menu-stack">
              {plannerSuggestion ? (
                <>
                  <section className="menu-section">
                    <div>
                      <span className="panel-kicker">Recommendation</span>
                      <h3>
                        {plannerSuggestion.recommendedAgentCount} recommended agent
                        {plannerSuggestion.recommendedAgentCount === 1 ? "" : "s"}
                      </h3>
                    </div>
                    <p>{plannerSuggestion.summary}</p>
                    <div className="compact-row">
                      <span className="compact-note">
                        advisor {plannerSuggestion.advisorProvider}/{plannerSuggestion.advisorModel}
                      </span>
                      {lastSavedPlannerRecommendation ? (
                        <span className="compact-note">
                          last saved {formatDateTime(lastSavedPlannerRecommendation.savedAt)}
                        </span>
                      ) : null}
                    </div>
                    <div className="settings-actions">
                      <button
                        className="outline-button"
                        disabled={plannerFleetPending}
                        onClick={() => void handleCreateSuggestedFleet(false)}
                        type="button"
                      >
                        {plannerFleetPending ? "Creating..." : "Create all suggested agents"}
                      </button>
                      <button
                        className="outline-button"
                        disabled={plannerFleetPending}
                        onClick={() => void handleCreateSuggestedFleet(true)}
                        type="button"
                      >
                        {plannerFleetPending ? "Launching..." : "Create and launch suggested agents"}
                      </button>
                      <button
                        className="outline-button"
                        disabled={plannerSavePending || saveSharedContextMutation.isPending}
                        onClick={() => void handleSavePlannerRecommendation()}
                        type="button"
                      >
                        {plannerSavePending || saveSharedContextMutation.isPending
                          ? "Saving..."
                          : "Save recommendation to workspace history"}
                      </button>
                    </div>
                  </section>

                  <section className="menu-section">
                    <div>
                      <span className="panel-kicker">Suggested agents</span>
                      <h3>Role and model mix</h3>
                    </div>
                    <div className="selection-grid">
                      {plannerSuggestion.agents.map((recommendation, index) => (
                        <article key={`${recommendation.role}-${index}`} className="selection-card planner-suggestion-card">
                          <div className="planner-suggestion-body">
                            <strong className="planner-suggestion-title">{recommendation.role}</strong>
                            <div className="menu-form-grid planner-agent-grid">
                              <label className="settings-field">
                                <span>Provider</span>
                                <select
                                  className="workspace-picker"
                                  value={(plannerAgentDrafts[index] ?? recommendation).provider}
                                  onChange={(event) =>
                                    handlePlannerAgentDraftChange(index, {
                                      provider: event.target.value as "codex" | "claude",
                                    })
                                  }
                                >
                                  <option value="codex">Codex</option>
                                  <option value="claude">Claude</option>
                                </select>
                              </label>
                              <label className="settings-field">
                                <span>Model</span>
                                <input
                                  type="text"
                                  value={(plannerAgentDrafts[index] ?? recommendation).model}
                                  onChange={(event) =>
                                    handlePlannerAgentDraftChange(index, {
                                      model: event.target.value,
                                    })
                                  }
                                  placeholder={recommendation.model}
                                />
                              </label>
                            </div>
                            <p>{recommendation.objective}</p>
                            <p>{recommendation.reasoning}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>

                  <section className="menu-section">
                    <div>
                      <span className="panel-kicker">Coordination</span>
                      <h3>Notes and risks</h3>
                    </div>
                    <div className="selection-grid">
                      <article className="selection-card">
                        <div>
                          <strong>Coordination notes</strong>
                          {plannerSuggestion.coordinationNotes.length > 0 ? (
                            <p>{plannerSuggestion.coordinationNotes.join(" ")}</p>
                          ) : (
                            <p>No coordination notes were returned.</p>
                          )}
                        </div>
                      </article>
                      <article className="selection-card">
                        <div>
                          <strong>Risks</strong>
                          {plannerSuggestion.risks.length > 0 ? (
                            <p>{plannerSuggestion.risks.join(" ")}</p>
                          ) : (
                            <p>No explicit risks were returned.</p>
                          )}
                        </div>
                      </article>
                    </div>
                  </section>
                </>
              ) : (
                <section className="menu-section">
                  <div>
                    <span className="panel-kicker">Recommendation</span>
                    <h3>No current fleet recommendation</h3>
                  </div>
                  <p>Generate a recommendation or load the last saved one to tune models and instantiate agents from it.</p>
                </section>
              )}
            </div>
          </div>
        ) : (
          <p>Select a workspace before requesting a fleet recommendation.</p>
        )}
      </section>
    );
  }

  function renderAgentsMenu(): JSX.Element {
    return (
      <section className="menu-panel">
        <div>
          <span className="panel-kicker">Agents</span>
          <h2>Create and launch</h2>
          <p>Build provider-backed agents against the selected project workspace and shared context.</p>
        </div>
        {workspaceData ? (
          <div className="menu-stack">
            <section className="menu-section">
              <div>
                <span className="panel-kicker">Launch config</span>
                <h3>New agent</h3>
              </div>
              <div className="menu-form-grid">
                <label className="settings-field">
                  <span>Provider</span>
                  <select
                    className="workspace-picker"
                    value={agentProviderDraft}
                    onChange={(event) => {
                      const nextProvider = event.target.value as "codex" | "claude";
                      setAgentProviderDraft(nextProvider);
                      setAgentModelDraft(defaultModelForProvider(nextProvider));
                    }}
                  >
                    <option value="codex">Codex</option>
                    <option value="claude">Claude</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>Model</span>
                  <input
                    type="text"
                    value={agentModelDraft}
                    onChange={(event) => setAgentModelDraft(event.target.value)}
                    placeholder={defaultModelForProvider(agentProviderDraft)}
                  />
                </label>
                <label className="settings-field">
                  <span>Title</span>
                  <input
                    type="text"
                    value={agentTitleCreateDraft}
                    onChange={(event) => setAgentTitleCreateDraft(event.target.value)}
                    placeholder="Optional display title"
                  />
                </label>
                <label className="settings-field">
                  <span>Role</span>
                  <input
                    type="text"
                    value={agentRoleDraft}
                    onChange={(event) => setAgentRoleDraft(event.target.value)}
                    placeholder="Reviewer, planner, implementer..."
                  />
                </label>
              </div>
              <label className="settings-field">
                <span>Working directory</span>
                <input
                  type="text"
                  value={agentCwdDraft}
                  onChange={(event) => setAgentCwdDraft(event.target.value)}
                  placeholder={workspaceData.workspace.projectRoot || "/absolute/path/to/repo"}
                />
              </label>
              <label className="settings-field">
                <span>Initial task</span>
                <textarea
                  className="settings-textarea"
                  value={agentTaskDraft}
                  onChange={(event) => setAgentTaskDraft(event.target.value)}
                  placeholder="Describe what this agent should do in the repo."
                  rows={6}
                />
              </label>
              <div className="settings-field">
                <span>Mount context packs</span>
                {contexts.length > 0 ? (
                  <div className="selection-grid">
                    {contexts.map((contextPack) => {
                      const selected = selectedContextPackIds.includes(contextPack.id);
                      return (
                        <label
                          key={contextPack.id}
                          className={selected ? "selection-card selection-card-active" : "selection-card"}
                        >
                          <input
                            checked={selected}
                            onChange={() =>
                              setSelectedContextPackIds((current) =>
                                current.includes(contextPack.id)
                                  ? current.filter((id) => id !== contextPack.id)
                                  : [...current, contextPack.id],
                              )
                            }
                            type="checkbox"
                          />
                          <div>
                            <strong>{contextPack.name}</strong>
                            <p>
                              {contextPack.items.length} items · v{contextPack.version}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="panel-empty">No context packs yet. Shared context will still be applied automatically.</p>
                )}
              </div>
              <div className="settings-actions">
                <button
                  className="outline-button"
                  disabled={!canCreateAgent || agentFlowPending}
                  onClick={() => void handleCreateAgent(false)}
                  type="button"
                >
                  {agentFlowPending ? "Creating..." : "Create agent"}
                </button>
                <button
                  className="outline-button"
                  disabled={!canCreateAgent || agentFlowPending}
                  onClick={() => void handleCreateAgent(true)}
                  type="button"
                >
                  {agentFlowPending ? "Launching..." : "Create and launch"}
                </button>
              </div>
            </section>

            <section className="menu-section">
              <div>
                <span className="panel-kicker">Current fleet</span>
                <h3>{agents.length} agents in this workspace</h3>
              </div>
              {agents.length > 0 ? (
                <div className="selection-grid">
                  {agents.map((agent) => (
                    <article key={agent.id} className="selection-card">
                      <div>
                        <strong>{agent.title}</strong>
                        <p>
                          {agent.provider} / {agent.model} · {agentStateMeta[agent.state].label}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="panel-empty">No agents created for this workspace yet.</p>
              )}
            </section>
          </div>
        ) : (
          <p>Select a workspace before creating agents.</p>
        )}
      </section>
    );
  }

  function renderContextMenu(): JSX.Element {
    return (
      <section className="menu-panel">
        <div>
          <span className="panel-kicker">Context</span>
          <h2>Shared workspace context</h2>
          <p>Everything here is editable in one place and is supplied to every agent in the workspace.</p>
        </div>
        {workspaceData ? (
          <div className="menu-stack">
            <section className="menu-section">
              <div>
                <span className="panel-kicker">Shared brief</span>
                <h3>Workspace-wide context</h3>
              </div>
              <label className="settings-field">
                <span>Shared context</span>
                <textarea
                  className="settings-textarea settings-textarea-large"
                  value={sharedContextDraft}
                  onChange={(event) => setSharedContextDraft(event.target.value)}
                  placeholder="Architecture notes, product constraints, coding standards, repo conventions..."
                  rows={14}
                />
              </label>
              <div className="settings-actions">
                <button
                  className="outline-button"
                  disabled={!canSaveSharedContext || saveSharedContextMutation.isPending}
                  onClick={() => void handleSaveSharedContext()}
                  type="button"
                >
                  {saveSharedContextMutation.isPending ? "Saving..." : "Save shared context"}
                </button>
              </div>
            </section>

            <section className="menu-section">
              <div>
                <span className="panel-kicker">Repo importer</span>
                <h3>{workspaceData.workspace.projectRoot || "Project root not configured"}</h3>
              </div>
              {workspaceData.workspace.projectRoot ? (
                <>
                  <div className="settings-actions">
                    <button
                      className="outline-button"
                      onClick={() => void projectFilesQuery.refetch()}
                      type="button"
                    >
                      Refresh candidate files
                    </button>
                  </div>
                  {projectFilesQuery.isLoading ? (
                    <p className="panel-empty">Scanning repo for good context candidates...</p>
                  ) : projectFileCandidates.length > 0 ? (
                    <>
                      <div className="selection-grid">
                        {projectFileCandidates.map((candidate: ProjectFileCandidateRecord) => {
                          const selected = selectedProjectFiles.includes(candidate.path);
                          return (
                            <label
                              key={candidate.path}
                              className={selected ? "selection-card selection-card-active" : "selection-card"}
                            >
                              <input
                                checked={selected}
                                onChange={() => handleToggleProjectFile(candidate.path)}
                                type="checkbox"
                              />
                              <div>
                                <strong>{candidate.path}</strong>
                                <p>
                                  {candidate.category} · {formatBytes(candidate.sizeBytes)}
                                </p>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                      <div className="settings-actions">
                        <button
                          className="outline-button"
                          disabled={selectedProjectFiles.length === 0 || importSharedContextMutation.isPending}
                          onClick={() => void handleImportProjectFiles("append")}
                          type="button"
                        >
                          {importSharedContextMutation.isPending ? "Importing..." : "Append selected files"}
                        </button>
                        <button
                          className="outline-button"
                          disabled={selectedProjectFiles.length === 0 || importSharedContextMutation.isPending}
                          onClick={() => void handleImportProjectFiles("replace")}
                          type="button"
                        >
                          {importSharedContextMutation.isPending ? "Importing..." : "Replace with selected files"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="panel-empty">No project files were discovered yet for this repo root.</p>
                  )}
                </>
              ) : (
                <p className="panel-empty">Set a project root in the Workspace screen before importing repo files.</p>
              )}
            </section>
          </div>
        ) : (
          <p>Select a workspace before editing shared context.</p>
        )}
      </section>
    );
  }

  function renderInboxThread(): JSX.Element {
    return (
      <section className="thread-surface panel-tone-home workspace-thread-surface">
        <div className="thread-panel-header">
          <div>
            <span className="panel-kicker">Inbox thread</span>
            <h2>Approvals and follow-ups</h2>
            <p>Keep risky tool requests and agent handoffs in one operational thread so you can triage without leaving the shell.</p>
          </div>
          <div className="compact-notices">
            <span className="compact-note">{pendingApprovals.length} approvals</span>
            <span className="compact-note">{workspaceInbox.length} handoffs</span>
          </div>
        </div>
        <div className="thread-stream">
          {pendingApprovals.length === 0 && workspaceInbox.length === 0 ? (
            <div className="panel-empty">No approvals or handoffs yet. They will appear here as agents ask for risky actions or create follow-ups.</div>
          ) : null}

          {pendingApprovals.map((approval: ApprovalRequestRecord) => (
            <article key={approval.id} className="thread-message thread-message-warning">
              <div className="event-item-header">
                <strong>{approval.requestedAction}</strong>
                <span>{formatDateTime(approval.createdAt)}</span>
              </div>
              <p>{approval.reason || "No explicit reason was included by the agent."}</p>
              <div className="compact-notices">
                <span className="compact-note">run {approval.runId}</span>
                <span className="compact-note">agent {approval.agentId}</span>
              </div>
              <pre className="file-preview-code">{JSON.stringify(approval.requestedPayload, null, 2)}</pre>
              <div className="settings-actions">
                <button className="outline-button" onClick={() => focusRun(approval.agentId, approval.runId)} type="button">
                  Open run
                </button>
                <button className="outline-button success-button" onClick={() => void handleApprove(approval.id)} type="button">
                  Approve
                </button>
                <button className="outline-button danger-button" onClick={() => void handleDeny(approval.id)} type="button">
                  Deny
                </button>
              </div>
            </article>
          ))}

          {workspaceInbox.map((handoff: HandoffItemRecord) => (
            <article key={handoff.id} className="thread-message thread-message-info">
              <div className="event-item-header">
                <strong>{handoff.title}</strong>
                <span>{handoff.status.toLowerCase()}</span>
              </div>
              <p>{handoff.summary}</p>
              <div className="compact-notices">
                <span className="compact-note">
                  {handoff.recommendedProvider}/{handoff.recommendedModel}
                </span>
                <span className="compact-note">{handoff.artifactIds.length} artifacts</span>
              </div>
              <p className="thread-message-detail">{truncateText(handoff.nextPrompt, 260)}</p>
              <div className="settings-actions">
                <button className="outline-button" onClick={() => focusRun(handoff.sourceAgentId, handoff.sourceRunId)} type="button">
                  Open source run
                </button>
                <button className="outline-button" onClick={() => void handleCreateAgentFromInbox(handoff.id)} type="button">
                  Create follow-up
                </button>
                {selectedAgent ? (
                  <button
                    className="outline-button"
                    onClick={() => void handleAssignInbox(handoff.id, selectedAgent.id)}
                    type="button"
                  >
                    Assign to {selectedAgent.title}
                  </button>
                ) : null}
                <button className="outline-button" onClick={() => void handleUpdateInboxStatus(handoff.id, "DONE")} type="button">
                  Done
                </button>
                <button
                  className="outline-button danger-button"
                  onClick={() => void handleUpdateInboxStatus(handoff.id, "DISMISSED")}
                  type="button"
                >
                  Dismiss
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  function renderProvidersMenu(): JSX.Element {
    return (
      <section className="menu-panel">
        <div>
          <span className="panel-kicker">Providers</span>
          <h2>Live model credentials</h2>
          <p>Store OpenAI and Claude keys for this installed app.</p>
        </div>
        <div className="menu-controls">
          <div className="settings-status compact-row">
            <span
              className={
                providerSettings?.openaiConfigured ? "settings-pill settings-pill-active" : "settings-pill"
              }
            >
              OpenAI {providerSettings?.openaiConfigured ? "configured" : "missing"}
            </span>
            <span
              className={
                providerSettings?.anthropicConfigured
                  ? "settings-pill settings-pill-active"
                  : "settings-pill"
              }
            >
              Claude {providerSettings?.anthropicConfigured ? "configured" : "missing"}
            </span>
            <span
              className={
                providerSettings?.coordinationConfigured
                  ? "settings-pill settings-pill-active"
                  : "settings-pill"
              }
            >
              Coordination {providerSettings?.coordinationConfigured ? "configured" : "missing"}
            </span>
          </div>
          {settingsAvailable ? (
            <>
              <label className="settings-field">
                <span>OpenAI API key</span>
                <input
                  type="password"
                  value={openaiApiKey}
                  onChange={(event) => setOpenaiApiKey(event.target.value)}
                  placeholder={
                    providerSettings?.openaiConfigured ? "Stored. Enter a new key to replace it." : "sk-..."
                  }
                />
              </label>
              <label className="settings-field">
                <span>Claude API key</span>
                <input
                  type="password"
                  value={anthropicApiKey}
                  onChange={(event) => setAnthropicApiKey(event.target.value)}
                  placeholder={
                    providerSettings?.anthropicConfigured
                      ? "Stored. Enter a new key to replace it."
                      : "sk-ant-..."
                  }
                />
              </label>
              <label className="settings-field">
                <span>Coordination key <small style={{opacity: 0.6}}>(Haiku synthesis — uses Claude key if not set)</small></span>
                <input
                  type="password"
                  value={coordinationApiKey}
                  onChange={(event) => setCoordinationApiKey(event.target.value)}
                  placeholder={
                    providerSettings?.coordinationConfigured
                      ? "Stored. Enter a new key to replace it."
                      : "sk-ant-... (optional, for team ask summaries)"
                  }
                />
              </label>
              <div className="settings-actions">
                <button
                  className="outline-button"
                  disabled={!hasPendingSettingsChanges || providerSettingsMutation.isPending}
                  onClick={() => void handleSaveProviderSettings()}
                  type="button"
                >
                  {providerSettingsMutation.isPending ? "Saving..." : "Save credentials"}
                </button>
                <button
                  className="chip"
                  disabled={!providerSettings?.openaiConfigured || providerSettingsMutation.isPending}
                  onClick={() => void handleClearProviderSettings("openai")}
                  type="button"
                >
                  Clear OpenAI
                </button>
                <button
                  className="chip"
                  disabled={!providerSettings?.anthropicConfigured || providerSettingsMutation.isPending}
                  onClick={() => void handleClearProviderSettings("anthropic")}
                  type="button"
                >
                  Clear Claude
                </button>
                <button
                  className="chip"
                  disabled={!providerSettings?.coordinationConfigured || providerSettingsMutation.isPending}
                  onClick={() => void handleClearProviderSettings("coordination")}
                  type="button"
                >
                  Clear Coordination
                </button>
              </div>
            </>
          ) : (
            <p>Provider settings are only editable from the desktop app runtime.</p>
          )}
        </div>
      </section>
    );
  }

  function renderRuntimeMenu(): JSX.Element {
    return (
      <section className="menu-panel">
        <div>
          <span className="panel-kicker">Runtime</span>
          <h2>Embedded control plane</h2>
          <p>Health and ownership state for the local backend that powers the UI.</p>
        </div>
        <div className="menu-controls">
          <div className="settings-status compact-row">
            <span className={healthQuery.data?.ok ? "settings-pill settings-pill-active" : "settings-pill"}>
              {healthQuery.data?.ok ? "reachable" : "offline"}
            </span>
            <span className={runtimeStatus?.appOwned ? "settings-pill settings-pill-active" : "settings-pill"}>
              {runtimeStatus?.appOwned ? "managed by app" : "external or missing"}
            </span>
            <span className={streamConnected ? "settings-pill settings-pill-active" : "settings-pill"}>
              {streamConnected ? "streaming" : "polling"}
            </span>
          </div>
          <p className="menu-runtime-copy">
            {healthQuery.data?.ok
              ? `The embedded control plane is responding on ${baseUrl}.`
              : runtimeStatus?.appOwned
                ? runtimeStatus.lastError
                  ? `Startup is retrying. Last error: ${runtimeStatus.lastError}`
                  : "The embedded backend is still starting."
                : `No backend is currently reachable on ${baseUrl}.`}
          </p>
        </div>
      </section>
    );
  }

  function renderActiveMenu(): JSX.Element | null {
    if (activeMenu === "settings") {
      return (
        <section className="menu-panel">
          <div>
            <span className="panel-kicker">Settings</span>
            <h2>Providers and runtime</h2>
            <p>Manage provider credentials and the embedded control plane in one place.</p>
          </div>
          <div className="menu-stack">
            <section className="menu-section">
              <div>
                <span className="panel-kicker">Current state</span>
                <h3>Desktop runtime</h3>
              </div>
              <div className="compact-notices">
                <span className={healthQuery.data?.ok ? "settings-pill settings-pill-active" : "settings-pill"}>
                  {healthQuery.data?.ok ? "connected" : "offline"}
                </span>
                <span className={streamConnected ? "settings-pill settings-pill-active" : "settings-pill"}>
                  {streamConnected ? "stream live" : "polling"}
                </span>
                <span
                  className={
                    providerSettings?.openaiConfigured ? "settings-pill settings-pill-active" : "settings-pill"
                  }
                >
                  OpenAI {providerSettings?.openaiConfigured ? "configured" : "missing"}
                </span>
                <span
                  className={
                    providerSettings?.anthropicConfigured ? "settings-pill settings-pill-active" : "settings-pill"
                  }
                >
                  Claude {providerSettings?.anthropicConfigured ? "configured" : "missing"}
                </span>
              </div>
              <div className="thread-sidebar-tabs settings-main-tabs">
                <button
                  className={settingsDrawerTab === "providers" ? "chip chip-active" : "chip"}
                  onClick={() => setSettingsDrawerTab("providers")}
                  type="button"
                >
                  Provider keys
                </button>
                <button
                  className={settingsDrawerTab === "runtime" ? "chip chip-active" : "chip"}
                  onClick={() => setSettingsDrawerTab("runtime")}
                  type="button"
                >
                  Runtime health
                </button>
              </div>
            </section>

            {settingsDrawerTab === "providers" ? (
              <section className="menu-section">
                <div>
                  <span className="panel-kicker">Providers</span>
                  <h3>Provider keys</h3>
                </div>
                <div className="compact-notices">
                  <span
                    className={
                      providerSettings?.openaiConfigured ? "settings-pill settings-pill-active" : "settings-pill"
                    }
                  >
                    OpenAI {providerSettings?.openaiConfigured ? "configured" : "missing"}
                  </span>
                  <span
                    className={
                      providerSettings?.anthropicConfigured ? "settings-pill settings-pill-active" : "settings-pill"
                    }
                  >
                    Claude {providerSettings?.anthropicConfigured ? "configured" : "missing"}
                  </span>
                  <span
                    className={
                      providerSettings?.coordinationConfigured ? "settings-pill settings-pill-active" : "settings-pill"
                    }
                  >
                    Coordination {providerSettings?.coordinationConfigured ? "configured" : "missing"}
                  </span>
                </div>
                {settingsAvailable ? (
                  <>
                    <div className="menu-form-grid">
                      <label className="settings-field">
                        <span>OpenAI API key</span>
                        <input
                          type="password"
                          value={openaiApiKey}
                          onChange={(event) => setOpenaiApiKey(event.target.value)}
                          placeholder={
                            providerSettings?.openaiConfigured
                              ? "Stored. Enter a new key to replace it."
                              : "sk-..."
                          }
                        />
                      </label>
                      <label className="settings-field">
                        <span>Claude API key</span>
                        <input
                          type="password"
                          value={anthropicApiKey}
                          onChange={(event) => setAnthropicApiKey(event.target.value)}
                          placeholder={
                            providerSettings?.anthropicConfigured
                              ? "Stored. Enter a new key to replace it."
                              : "sk-ant-..."
                          }
                        />
                      </label>
                      <label className="settings-field">
                        <span>Coordination key <small style={{opacity: 0.6}}>(Haiku synthesis — uses Claude key if not set)</small></span>
                        <input
                          type="password"
                          value={coordinationApiKey}
                          onChange={(event) => setCoordinationApiKey(event.target.value)}
                          placeholder={
                            providerSettings?.coordinationConfigured
                              ? "Stored. Enter a new key to replace it."
                              : "sk-ant-... (optional, for team ask summaries)"
                          }
                        />
                      </label>
                    </div>
                    <div className="settings-actions">
                      <button
                        className="outline-button"
                        disabled={!hasPendingSettingsChanges || providerSettingsMutation.isPending}
                        onClick={() => void handleSaveProviderSettings()}
                        type="button"
                      >
                        {providerSettingsMutation.isPending ? "Saving..." : "Save"}
                      </button>
                      <button
                        className="outline-button"
                        disabled={!providerSettings?.openaiConfigured || providerSettingsMutation.isPending}
                        onClick={() => void handleClearProviderSettings("openai")}
                        type="button"
                      >
                        Clear OpenAI
                      </button>
                      <button
                        className="outline-button"
                        disabled={!providerSettings?.anthropicConfigured || providerSettingsMutation.isPending}
                        onClick={() => void handleClearProviderSettings("anthropic")}
                        type="button"
                      >
                        Clear Claude
                      </button>
                      <button
                        className="outline-button"
                        disabled={!providerSettings?.coordinationConfigured || providerSettingsMutation.isPending}
                        onClick={() => void handleClearProviderSettings("coordination")}
                        type="button"
                      >
                        Clear Coordination
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="menu-muted-copy">Provider settings are only editable from the desktop runtime.</p>
                )}
              </section>
            ) : null}

            {settingsDrawerTab === "runtime" ? (
              <section className="menu-section">
                <div>
                  <span className="panel-kicker">Runtime</span>
                  <h3>Embedded control plane</h3>
                </div>
                <div className="compact-notices">
                  <span className={healthQuery.data?.ok ? "settings-pill settings-pill-active" : "settings-pill"}>
                    {healthQuery.data?.ok ? "connected" : "offline"}
                  </span>
                  <span
                    className={runtimeStatus?.appOwned ? "settings-pill settings-pill-active" : "settings-pill"}
                  >
                    {runtimeStatus?.appOwned ? "managed by app" : "external or missing"}
                  </span>
                  <span className={streamConnected ? "settings-pill settings-pill-active" : "settings-pill"}>
                    {streamConnected ? "stream live" : "polling"}
                  </span>
                </div>
                <p className="menu-muted-copy">
                  {healthQuery.data?.ok
                    ? `The embedded control plane is responding on ${baseUrl}.`
                    : runtimeStatus?.appOwned
                      ? runtimeStatus.lastError
                        ? `Startup is retrying. Last error: ${runtimeStatus.lastError}`
                        : "The embedded backend is still starting."
                      : `No backend is currently reachable on ${baseUrl}.`}
                </p>
                <div className="settings-actions">
                  <button className="outline-button" onClick={() => void healthQuery.refetch()} type="button">
                    Refresh health
                  </button>
                  <button className="outline-button" onClick={() => void runtimeStatusQuery.refetch()} type="button">
                    Refresh runtime
                  </button>
                </div>
              </section>
            ) : null}
          </div>
        </section>
      );
    }

    return null;
  }

  function renderSettingsDrawer(): JSX.Element {
    const tabs: Array<{ id: SettingsDrawerTab; label: string }> = [
      { id: "providers", label: "Providers" },
      { id: "runtime", label: "Runtime" },
    ];

    return (
      <aside className="thread-sidebar panel-tone-home settings-drawer">
        <div className="thread-sidebar-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={settingsDrawerTab === tab.id ? "chip chip-active" : "chip"}
              onClick={() => setSettingsDrawerTab(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="thread-sidebar-body">
          {settingsDrawerTab === "providers" ? (
            <div className="thread-sidebar-stack">
              <section className="thread-side-card">
                <div className="dock-subheader">
                  <strong>Provider keys</strong>
                  <span className="compact-note">Stored in the desktop runtime</span>
                </div>
                <div className="compact-notices">
                  <span
                    className={
                      providerSettings?.openaiConfigured ? "settings-pill settings-pill-active" : "settings-pill"
                    }
                  >
                    OpenAI {providerSettings?.openaiConfigured ? "configured" : "missing"}
                  </span>
                  <span
                    className={
                      providerSettings?.anthropicConfigured
                        ? "settings-pill settings-pill-active"
                        : "settings-pill"
                    }
                  >
                    Claude {providerSettings?.anthropicConfigured ? "configured" : "missing"}
                  </span>
                </div>
                {settingsAvailable ? (
                  <>
                    <label className="settings-field">
                      <span>OpenAI API key</span>
                      <input
                        type="password"
                        value={openaiApiKey}
                        onChange={(event) => setOpenaiApiKey(event.target.value)}
                        placeholder={
                          providerSettings?.openaiConfigured
                            ? "Stored. Enter a new key to replace it."
                            : "sk-..."
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Claude API key</span>
                      <input
                        type="password"
                        value={anthropicApiKey}
                        onChange={(event) => setAnthropicApiKey(event.target.value)}
                        placeholder={
                          providerSettings?.anthropicConfigured
                            ? "Stored. Enter a new key to replace it."
                            : "sk-ant-..."
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Coordination key <small style={{opacity: 0.6}}>(Haiku synthesis — uses Claude key if not set)</small></span>
                      <input
                        type="password"
                        value={coordinationApiKey}
                        onChange={(event) => setCoordinationApiKey(event.target.value)}
                        placeholder={
                          providerSettings?.coordinationConfigured
                            ? "Stored. Enter a new key to replace it."
                            : "sk-ant-... (optional, for team ask summaries)"
                        }
                      />
                    </label>
                    <div className="settings-actions">
                      <button
                        className="outline-button"
                        disabled={!hasPendingSettingsChanges || providerSettingsMutation.isPending}
                        onClick={() => void handleSaveProviderSettings()}
                        type="button"
                      >
                        {providerSettingsMutation.isPending ? "Saving..." : "Save"}
                      </button>
                      <button
                        className="outline-button"
                        disabled={!providerSettings?.openaiConfigured || providerSettingsMutation.isPending}
                        onClick={() => void handleClearProviderSettings("openai")}
                        type="button"
                      >
                        Clear OpenAI
                      </button>
                      <button
                        className="outline-button"
                        disabled={!providerSettings?.anthropicConfigured || providerSettingsMutation.isPending}
                        onClick={() => void handleClearProviderSettings("anthropic")}
                        type="button"
                      >
                        Clear Claude
                      </button>
                      <button
                        className="outline-button"
                        disabled={!providerSettings?.coordinationConfigured || providerSettingsMutation.isPending}
                        onClick={() => void handleClearProviderSettings("coordination")}
                        type="button"
                      >
                        Clear Coordination
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="menu-muted-copy">Provider settings are only editable from the desktop runtime.</p>
                )}
              </section>
            </div>
          ) : null}

          {settingsDrawerTab === "runtime" ? (
            <div className="thread-sidebar-stack">
              <section className="thread-side-card">
                <div className="dock-subheader">
                  <strong>Embedded control plane</strong>
                  <span className="compact-note">{healthQuery.data?.ok ? "healthy" : "degraded"}</span>
                </div>
                <div className="compact-notices">
                  <span className={healthQuery.data?.ok ? "settings-pill settings-pill-active" : "settings-pill"}>
                    {healthQuery.data?.ok ? "connected" : "offline"}
                  </span>
                  <span
                    className={runtimeStatus?.appOwned ? "settings-pill settings-pill-active" : "settings-pill"}
                  >
                    {runtimeStatus?.appOwned ? "managed by app" : "external or missing"}
                  </span>
                  <span className={streamConnected ? "settings-pill settings-pill-active" : "settings-pill"}>
                    {streamConnected ? "stream live" : "polling"}
                  </span>
                </div>
                <p className="menu-muted-copy">
                  {healthQuery.data?.ok
                    ? `The embedded control plane is responding on ${baseUrl}.`
                    : runtimeStatus?.appOwned
                      ? runtimeStatus.lastError
                        ? `Startup is retrying. Last error: ${runtimeStatus.lastError}`
                        : "The embedded backend is still starting."
                      : `No backend is currently reachable on ${baseUrl}.`}
                </p>
                <div className="settings-actions">
                  <button className="outline-button" onClick={() => void healthQuery.refetch()} type="button">
                    Refresh health
                  </button>
                  <button className="outline-button" onClick={() => void runtimeStatusQuery.refetch()} type="button">
                    Refresh runtime
                  </button>
                </div>
              </section>
            </div>
          ) : null}
        </div>
      </aside>
    );
  }

  function renderExplorerTabStrip(): JSX.Element | null {
    if (openExplorerTabs.length === 0) {
      return null;
    }

    return (
      <div className="file-preview-tabs">
        {openExplorerTabs.map((path) => {
          const isActive = selectedExplorerFilePath === path;
          const isDirty = isActive && explorerFileDirty;

          return (
            <div
              key={path}
              className={isActive ? "file-preview-tab file-preview-tab-active" : "file-preview-tab"}
              title={path}
            >
              <button
                className="file-preview-tab-button"
                onClick={() => setSelectedExplorerFilePath(path)}
                type="button"
              >
                <span>{getPathLeaf(path)}</span>
                {isDirty ? <span className="file-preview-tab-dirty">•</span> : null}
              </button>
              <button
                aria-label={`Close ${getPathLeaf(path)}`}
                className="file-preview-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  closeExplorerFile(path);
                }}
                type="button"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  function renderExplorerWorkspaceTool(): JSX.Element {
    const scopeLabel = explorerScopedAgent
      ? `${explorerScopedAgent.title} · ${explorerScopedAgent.worktree?.path ? "agent worktree" : "workspace root"}`
      : `${workspaceData?.workspace.name ?? "Workspace"} · workspace root`;

    return (
      <div className="explorer-layout explorer-layout-sidebar">
        <div className="file-tree">
          <div className="explorer-toolbar">
            <div className="dock-subheader">
              <strong>Files</strong>
              <span className="compact-note">{scopeLabel}</span>
            </div>
            <div className="explorer-toolbar-row">
              <div className="explorer-actions">
                <button
                  className="outline-button"
                  disabled={!explorerRoot || normalizePathString(explorerRoot) === normalizePathString(explorerBoundaryRoot)}
                  onClick={() => handleExplorerNavigateUp()}
                  type="button"
                >
                  Up
                </button>
                <button
                  className="outline-button"
                  disabled={!explorerBoundaryRoot}
                  onClick={() => handleExplorerReset()}
                  type="button"
                >
                  Root
                </button>
              </div>
              <div className="explorer-location-bar">
                <input
                  className="dock-terminal-input"
                  type="text"
                  value={explorerLocationDraft}
                  onChange={(event) => setExplorerLocationDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleExplorerNavigate();
                    }
                  }}
                  placeholder={explorerBoundaryRoot || "Type a folder path inside the workspace root"}
                />
                <button className="outline-button" onClick={() => handleExplorerNavigate()} type="button">
                  Go
                </button>
              </div>
            </div>
            <div className="explorer-location-bar">
              <input
                className="dock-terminal-input"
                type="text"
                value={explorerSearchDraft}
                onChange={(event) => setExplorerSearchDraft(event.target.value)}
                placeholder="Search files in this tree"
              />
              <button
                className="outline-button"
                disabled={!explorerSearchDraft.trim()}
                onClick={() => setExplorerSearchDraft("")}
                type="button"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="explorer-tree-scroll">
            {projectTreeQuery.isLoading ? (
              <p className="panel-empty">Loading project tree...</p>
            ) : explorerSearchTerm ? (
              explorerSearchResults.length > 0 ? (
                <div className="explorer-entry-list">{explorerSearchResults.map((node) => renderExplorerEntry(node))}</div>
              ) : (
                <p className="panel-empty">No files or folders match this search.</p>
              )
            ) : projectTreeNodes.length > 0 ? (
              projectTreeNodes.map((node) => renderExplorerTreeNode(node))
            ) : (
              <p className="panel-empty">Set a valid project root or select an agent worktree to browse the repo tree here.</p>
            )}
          </div>
        </div>
        <div className="file-preview">
          {renderExplorerTabStrip()}
          <div className="dock-subheader">
            <strong>{selectedExplorerDisplayPath || "No file selected"}</strong>
            <div className="settings-actions">
              {selectedExplorerTruncated ? <span className="compact-note">preview truncated</span> : null}
              {explorerFileDirty ? <span className="compact-note">unsaved</span> : null}
              <button
                className="outline-button"
                disabled={!explorerFileDirty || fileSavePending}
                onClick={() => handleRevertExplorerFile()}
                type="button"
              >
                Revert
              </button>
              <button
                className="outline-button success-button"
                disabled={!explorerFileDirty || fileSavePending || !canEditExplorerFile}
                onClick={() => void handleSaveExplorerFile()}
                type="button"
              >
                {fileSavePending ? "Saving..." : "Save file"}
              </button>
            </div>
          </div>
          <textarea
            className="file-preview-editor"
            disabled={!selectedExplorerFilePath || filePreviewPending}
            onChange={(event) => setSelectedExplorerContent(event.target.value)}
            readOnly={!canEditExplorerFile}
            value={filePreviewPending ? "Loading file preview..." : selectedExplorerContent || "Select a file from the tree."}
          />
        </div>
      </div>
    );
  }

  function renderTerminalSidebar(): JSX.Element {
    const cwd =
      selectedAgent?.worktree?.path ||
      (selectedAgent?.metadata.cwd as string | undefined) ||
      workspaceData?.workspace.projectRoot ||
      "";

    return (
      <div className="thread-sidebar-stack">
        <section className="thread-side-card">
          <div className="dock-subheader">
            <strong>Terminal</strong>
            <span className="compact-note">{cwd || "set a project root first"}</span>
          </div>
          <div className="settings-actions dock-terminal-actions">
            <input
              className="dock-terminal-input"
              type="text"
              value={terminalCommandDraft}
              onChange={(event) => setTerminalCommandDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleRunTerminal();
                }
              }}
              placeholder={`Run a command in ${cwd || "the current project root"}`}
            />
            <button
              className="outline-button"
              disabled={terminalPending || terminalCommandDraft.trim().length === 0}
              onClick={() => void handleRunTerminal()}
              type="button"
            >
              {terminalPending ? "Running..." : "Run"}
            </button>
          </div>
          <div className="terminal-log terminal-log-sidebar">
            {terminalHistory.length > 0 ? (
              terminalHistory.map((entry, index) => (
                <article key={`${entry.command}-${index}`} className="terminal-entry">
                  <div className="dock-subheader">
                    <strong>{entry.command}</strong>
                    <span className={entry.exitCode === 0 ? "badge badge-success" : "badge badge-danger"}>
                      exit {entry.exitCode}
                    </span>
                  </div>
                  <p className="terminal-cwd">{entry.cwd}</p>
                  <pre className="file-preview-code">
                    {[entry.stdout, entry.stderr].filter(Boolean).join("\n\n") || "Command produced no output."}
                  </pre>
                </article>
              ))
            ) : (
              <p className="panel-empty">Run commands here to inspect the repo without leaving the shell.</p>
            )}
          </div>
        </section>
      </div>
    );
  }

  function artifactKindLabel(kind: ArtifactRecord["kind"]): string {
    switch (kind) {
      case "patch":
        return "Patch";
      case "log":
        return "Log";
      case "trace":
        return "Trace";
      case "file":
      default:
        return "File";
    }
  }

  function renderArtifactInlineCard(
    artifactId: string,
    artifact: ArtifactRecord,
    footer?: ReactNode,
  ): JSX.Element {
    const preview = artifactPreviewCache[artifact.uri];
    const artifactTitle = getPathLeaf(artifact.uri) || artifact.uri;
    const showPreview = ["patch", "log", "trace"].includes(artifact.kind);

    return (
      <article
        key={artifactId}
        className={`thread-message thread-message-artifact thread-message-artifact-${artifact.kind}`}
      >
        <div className="event-item-header">
          <div className="thread-artifact-head">
            <span className="panel-kicker">{artifactKindLabel(artifact.kind)}</span>
            <strong title={artifact.uri}>{artifactTitle}</strong>
          </div>
          <span>{formatEventTimestamp(artifact.createdAt)}</span>
        </div>
        <div className="compact-notices">
          <span className="compact-note">{artifact.kind}</span>
          {artifact.runId ? <span className="compact-note">run {artifact.runId}</span> : null}
          <span className="compact-note" title={artifact.uri}>
            {artifact.uri}
          </span>
        </div>
        {showPreview ? (
          preview?.error ? (
            <p className="thread-message-detail">{preview.error}</p>
          ) : preview ? (
            renderArtifactPreview(artifact.kind, preview.content, preview.truncated)
          ) : (
            <p className="thread-message-detail">Loading preview...</p>
          )
        ) : (
          <p className="thread-message-detail">Open the file rail to inspect this artifact in context.</p>
        )}
        {footer ? <div className="settings-actions">{footer}</div> : null}
      </article>
    );
  }

  function renderArtifactsSidebar(): JSX.Element {
    const toolTraceEvents = runToolCalls.slice().reverse().slice(0, 12);

    return (
      <div className="thread-sidebar-stack">
        <section className="thread-side-card">
          <div className="dock-subheader">
            <strong>Artifacts</strong>
            <span className="compact-note">
              {selectedAgent
                ? `${selectedAgent.title} · ${selectedRun ? "selected run" : "latest agent outputs"}`
                : "Select an agent first"}
            </span>
          </div>
          {selectedAgent ? (
            <>
              <div className="run-summary-grid run-summary-grid-sidebar">
                <article className="run-card">
                  <span className="panel-kicker">Patches</span>
                  <strong>{selectedRunPatchArtifacts.length}</strong>
                  <p>
                    {selectedRunPatchArtifacts[0]
                      ? truncateText(selectedRunPatchArtifacts[0].uri, 120)
                      : "No patch artifact yet."}
                  </p>
                </article>
                <article className="run-card">
                  <span className="panel-kicker">Logs</span>
                  <strong>{selectedRunLogArtifacts.length}</strong>
                  <p>
                    {selectedRunLogArtifacts[0]
                      ? truncateText(selectedRunLogArtifacts[0].uri, 120)
                      : "No log artifact yet."}
                  </p>
                </article>
                <article className="run-card">
                  <span className="panel-kicker">Files + traces</span>
                  <strong>{selectedRunFileArtifacts.length + selectedRunTraceArtifacts.length}</strong>
                  <p>Persisted files, traces, and other run outputs.</p>
                </article>
              </div>

              {runArtifacts.length > 0 || agentArtifacts.length > 0 ? (
                <div className="thread-sidebar-stack">
                  {(runArtifacts.length > 0 ? runArtifacts : agentArtifacts).map((artifact) =>
                    renderArtifactInlineCard(artifact.id, artifact),
                  )}
                </div>
              ) : (
                <p className="panel-empty">No persisted artifacts for this agent yet.</p>
              )}

              {toolTraceEvents.length > 0 ? (
                <section className="thread-side-card">
                  <div className="dock-subheader">
                    <strong>Recent tool trace</strong>
                    <span className="compact-note">{toolTraceEvents.length} steps</span>
                  </div>
                  <div className="thread-sidebar-stack">
                    {toolTraceEvents.map((event) => (
                      <article key={event.id} className="thread-message thread-message-info">
                        <div className="event-item-header">
                          <strong>{event.toolName}</strong>
                          <span>{formatEventTimestamp(event.updatedAt)}</span>
                        </div>
                        <div className="compact-notices">
                          <span className="compact-note">{event.status}</span>
                          {event.requestedCwd ? <span className="compact-note">{event.requestedCwd}</span> : null}
                          {event.approvalId ? <span className="compact-note">approval {event.approvalId}</span> : null}
                        </div>
                        <pre className="file-preview-code">{formatJsonPreview(event.input)}</pre>
                        {event.output ? <pre className="file-preview-code">{formatJsonPreview(event.output)}</pre> : null}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          ) : (
            <p className="panel-empty">Select an agent to inspect its artifacts, diffs, logs, and traces.</p>
          )}
        </section>
      </div>
    );
  }

  function renderDetailsSidebar(): JSX.Element {
    if (selectedAgent) {
      return (
        <div className="thread-sidebar-stack">
          <section className="thread-side-card">
            <div className="dock-subheader">
              <strong>{selectedAgent.title}</strong>
              <span className={`badge badge-${agentStateMeta[selectedAgent.state].tone}`}>
                {agentStateMeta[selectedAgent.state].label}
              </span>
            </div>
            <div className="compact-notices">
              <span className="compact-note">
                {selectedAgent.provider} / {selectedAgent.model}
              </span>
              <span className="compact-note">
                {selectedAgent.worktree?.path ? "agent worktree" : "workspace root"}
              </span>
            </div>
            <label className="settings-field">
              <span>Agent title</span>
              <input
                type="text"
                value={agentTitleDraft}
                onChange={(event) => setAgentTitleDraft(event.target.value)}
                placeholder="Agent title"
              />
            </label>
            <label className="settings-field">
              <span>Working directory</span>
              <input
                type="text"
                value={agentWorkingDirectoryDraft}
                onChange={(event) => setAgentWorkingDirectoryDraft(event.target.value)}
                placeholder={workspaceData?.workspace.projectRoot || "Use workspace project root"}
              />
            </label>
            <div className="settings-actions">
              <button
                className="outline-button"
                disabled={!canRenameAgent || renameAgentMutation.isPending}
                onClick={() => void handleRenameAgent()}
                type="button"
              >
                {renameAgentMutation.isPending ? "Saving..." : "Save settings"}
              </button>
              <button
                className="outline-button"
                disabled={startSelectedAgentMutation.isPending}
                onClick={() => void handleStartSelectedAgent()}
                type="button"
              >
                {startSelectedAgentMutation.isPending ? "Starting..." : "Start"}
              </button>
              <button
                className="outline-button"
                disabled={interruptSelectedAgentMutation.isPending || selectedAgent.state !== "RUNNING"}
                onClick={() => void handleInterruptSelectedAgent()}
                type="button"
              >
                {interruptSelectedAgentMutation.isPending ? "Interrupting..." : "Interrupt"}
              </button>
              <button
                className="outline-button danger-button"
                disabled={
                  stopSelectedAgentMutation.isPending ||
                  selectedAgent.state === "STOPPED" ||
                  selectedAgent.state === "COMPLETED"
                }
                onClick={() => void handleStopSelectedAgent()}
                type="button"
              >
                {stopSelectedAgentMutation.isPending ? "Stopping..." : "Stop"}
              </button>
              <button
                className="outline-button"
                disabled={renameAgentMutation.isPending || agentWorkingDirectoryDraft.trim().length === 0}
                onClick={() => setAgentWorkingDirectoryDraft("")}
                type="button"
              >
                Use workspace root
              </button>
            </div>
            <dl className="meta-list meta-list-compact">
              <div>
                <dt>Working directory</dt>
                <dd>
                  {selectedAgent.worktree?.path ??
                    (typeof selectedAgent.metadata.cwd === "string" ? selectedAgent.metadata.cwd : "Workspace default")}
                </dd>
              </div>
              <div>
                <dt>Monitor</dt>
                <dd>{getAgentMonitor(selectedAgent)}</dd>
              </div>
              <div>
                <dt>Cost</dt>
                <dd>{usageFormatters.cost(selectedAgent.usage.totalCostUsd)}</dd>
              </div>
              <div>
                <dt>Last event</dt>
                <dd>{formatEventTimestamp(selectedAgent.lastEventAt)}</dd>
              </div>
            </dl>
          </section>

          <section className="thread-side-card">
            <div className="dock-subheader">
              <strong>Latest run</strong>
              {selectedRun ? <span className="compact-note">{selectedRun.state.toLowerCase()}</span> : null}
            </div>
            <p className="menu-muted-copy">
              {selectedRun ? truncateText(selectedRun.prompt, 220) : "No tracked run selected yet."}
            </p>
            <div className="compact-notices">
              <span className="compact-note">{runToolCalls.length} tool steps</span>
              <span className="compact-note">{runArtifacts.length} artifacts</span>
              <span className="compact-note">{selectedRunApprovals.length} approvals</span>
            </div>
          </section>
        </div>
      );
    }

    return (
      <div className="thread-sidebar-stack">
        <section className="thread-side-card">
          <div className="dock-subheader">
            <strong>Create agent</strong>
            <span className="compact-note">
              {agentProviderDraft} / {agentModelDraft.trim() || defaultModelForProvider(agentProviderDraft)}
            </span>
          </div>
          <div className="menu-form-grid">
            <label className="settings-field">
              <span>Provider</span>
              <select
                className="workspace-picker"
                value={agentProviderDraft}
                onChange={(event) => {
                  const nextProvider = event.target.value as "codex" | "claude";
                  setAgentProviderDraft(nextProvider);
                  setAgentModelDraft(defaultModelForProvider(nextProvider));
                }}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label className="settings-field">
              <span>Model</span>
              <input
                type="text"
                value={agentModelDraft}
                onChange={(event) => setAgentModelDraft(event.target.value)}
                placeholder={defaultModelForProvider(agentProviderDraft)}
              />
            </label>
            <label className="settings-field">
              <span>Title</span>
              <input
                type="text"
                value={agentTitleCreateDraft}
                onChange={(event) => setAgentTitleCreateDraft(event.target.value)}
                placeholder="Optional display title"
              />
            </label>
            <label className="settings-field">
              <span>Role</span>
              <input
                type="text"
                value={agentRoleDraft}
                onChange={(event) => setAgentRoleDraft(event.target.value)}
                placeholder="Reviewer, planner, implementer..."
              />
            </label>
          </div>
            <label className="settings-field">
              <span>Task</span>
              <textarea
                className="settings-textarea settings-textarea-sidebar"
                value={agentTaskDraft}
              onChange={(event) => setAgentTaskDraft(event.target.value)}
              placeholder="Describe what this agent should do in the repo."
              rows={8}
              />
            </label>
            <div className="settings-field">
              <span>Mount context packs</span>
              {contexts.length > 0 ? (
                <div className="selection-grid">
                  {contexts.map((contextPack) => {
                    const selected = selectedContextPackIds.includes(contextPack.id);
                    return (
                      <label
                        key={contextPack.id}
                        className={selected ? "selection-card selection-card-active" : "selection-card"}
                      >
                        <input
                          checked={selected}
                          onChange={() =>
                            setSelectedContextPackIds((current) =>
                              current.includes(contextPack.id)
                                ? current.filter((id) => id !== contextPack.id)
                                : [...current, contextPack.id],
                            )
                          }
                          type="checkbox"
                        />
                        <div>
                          <strong>{contextPack.name}</strong>
                          <p>
                            {contextPack.items.length} items · v{contextPack.version}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="panel-empty">No context packs yet. Shared context will still mount automatically.</p>
              )}
            </div>
            <label className="settings-field">
              <span>Working directory</span>
              <input
                type="text"
                value={agentCwdDraft}
              onChange={(event) => setAgentCwdDraft(event.target.value)}
              placeholder={workspaceData?.workspace.projectRoot || "/absolute/path/to/repo"}
            />
          </label>
          <div className="settings-actions">
            <button
              className="outline-button"
              disabled={!canCreateAgent || agentFlowPending}
              onClick={() => void handleCreateAgent(false)}
              type="button"
            >
              {agentFlowPending ? "Creating..." : "Create"}
            </button>
            <button
              className="outline-button"
              disabled={!canCreateAgent || agentFlowPending}
              onClick={() => void handleCreateAgent(true)}
              type="button"
            >
              {agentFlowPending ? "Launching..." : "Create + launch"}
            </button>
          </div>
        </section>

        <section className="thread-side-card">
          <div className="dock-subheader">
            <strong>Workspace details</strong>
            <span className="compact-note">{agents.length} agents</span>
          </div>
          <div className="compact-notices">
            <span className={healthQuery.data?.ok ? "settings-pill settings-pill-active" : "settings-pill"}>
              {healthQuery.data?.ok ? "connected" : "offline"}
            </span>
            <span className={streamConnected ? "settings-pill settings-pill-active" : "settings-pill"}>
              {streamConnected ? "stream live" : "polling"}
            </span>
          </div>
          <p className="menu-muted-copy">
            Use the workspace thread to coordinate the fleet, then focus an agent from the thread toolbar when you want to narrow to one worker.
          </p>
        </section>
      </div>
    );
  }

  function renderWorkspaceSettingsPopover(): JSX.Element {
    return (
      <div className="workspace-settings-popover-layer">
        <div
          className="workspace-settings-popover panel-tone-home"
          style={
            workspaceSettingsPopoverPosition
              ? {
                  top: `${workspaceSettingsPopoverPosition.top}px`,
                  left: `${workspaceSettingsPopoverPosition.left}px`,
                  width: `${workspaceSettingsPopoverPosition.width}px`,
                }
              : undefined
          }
        >
          <section className="thread-side-card workspace-popover-card">
            <div className="dock-subheader">
              <strong>Current workspace</strong>
              <span className="compact-note">{workspaceData?.workspace.name ?? "No workspace selected"}</span>
            </div>
            <label className="settings-field">
              <span>Name</span>
              <input
                type="text"
                value={workspaceNameDraft}
                onChange={(event) => setWorkspaceNameDraft(event.target.value)}
                placeholder="Agent Command Center"
              />
            </label>
            <label className="settings-field">
              <span>Project root</span>
              <input
                type="text"
                value={workspaceProjectRootDraft}
                onChange={(event) => setWorkspaceProjectRootDraft(event.target.value)}
                placeholder="/absolute/path/to/repo"
              />
            </label>
            <div className="settings-actions">
              <button className="outline-button outline-button-small" onClick={() => void handleRenameWorkspace()} type="button">
                Save
              </button>
              <button className="outline-button outline-button-small" onClick={() => void handleSeedDemoBoard()} type="button">
                Seed demo
              </button>
            </div>
          </section>

          <section className="thread-side-card workspace-popover-card">
            <div className="dock-subheader">
              <strong>New workspace</strong>
              <span className="compact-note">Create a repo space</span>
            </div>
            <label className="settings-field">
              <span>Name</span>
              <input
                type="text"
                value={newWorkspaceDraft}
                onChange={(event) => setNewWorkspaceDraft(event.target.value)}
                placeholder="Agent Command Center"
              />
            </label>
            <label className="settings-field">
              <span>Project root</span>
              <input
                type="text"
                value={newWorkspaceProjectRootDraft}
                onChange={(event) => setNewWorkspaceProjectRootDraft(event.target.value)}
                placeholder="/absolute/path/to/repo"
              />
            </label>
            <div className="settings-actions">
              <button className="outline-button outline-button-small" onClick={() => void handleCreateWorkspace(false)} type="button">
                {createWorkspaceMutation.isPending && !bootstrapDemoMutation.isPending ? "Creating..." : "Create"}
              </button>
              <button
                className="outline-button outline-button-small"
                disabled={createWorkspaceMutation.isPending || bootstrapDemoMutation.isPending}
                onClick={() => void handleCreateWorkspace(true)}
                type="button"
              >
                {createWorkspaceMutation.isPending || bootstrapDemoMutation.isPending ? "Launching..." : "Create + demo"}
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  function renderRightSidebar(): JSX.Element {
    const tabs: Array<{ id: RightSidebarTab; label: string }> = [
      { id: "files", label: "Files" },
      { id: "terminal", label: "Terminal" },
      { id: "artifacts", label: "Artifacts" },
    ];

    if (homeThread.kind === "agent") {
      tabs.push({ id: "details", label: "Agent" });
    }

    return (
      <aside className="thread-sidebar panel-tone-home">
        <div className="thread-sidebar-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={rightSidebarTab === tab.id ? "chip chip-active" : "chip"}
              onClick={() => setRightSidebarTab(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="thread-sidebar-body">
          {rightSidebarTab === "files" ? renderExplorerWorkspaceTool() : null}
          {rightSidebarTab === "terminal" ? renderTerminalSidebar() : null}
          {rightSidebarTab === "artifacts" ? renderArtifactsSidebar() : null}
          {rightSidebarTab === "details" ? renderDetailsSidebar() : null}
        </div>
      </aside>
    );
  }

  function renderWorkspaceThread(): JSX.Element {
    const coordinationState = workspaceData?.coordinationState ?? null;
    const focusedExecutionRoot =
      workspaceFocusedAgent?.worktree?.path ||
      (typeof workspaceFocusedAgent?.metadata.cwd === "string" ? workspaceFocusedAgent.metadata.cwd : "") ||
      workspaceData?.workspace.projectRoot ||
      "";
    const focusedAgentTitle = workspaceFocusedAgent?.title ?? "Focused agent";
    const sharedContextAvailable = Boolean(workspaceData?.workspace.sharedContext.trim().length);
    const plannerGuidanceActive = Boolean(activeCoordinationBrief);
    const contextPackCount = workspaceData?.contextsSummary.length ?? 0;
    const cleanedSharedContextPreview = truncateText(cleanedSharedContext.replace(/\s+/g, " ").trim(), 170);
    const sharedContextWordCount = cleanedSharedContext
      ? cleanedSharedContext
          .split(/\s+/)
          .map((word) => word.trim())
          .filter(Boolean).length
      : 0;
    const plannerSummaryPreview = truncateText(
      (activeCoordinationBrief?.summary || activeCoordinationBrief?.task || "Planner guidance ready.")
        .replace(/\s+/g, " ")
        .trim(),
      170,
    );
    const plannerCoordinationCount = activeCoordinationBrief?.coordinationNotes.filter(Boolean).length ?? 0;
    const plannerRiskCount = activeCoordinationBrief?.risks.filter(Boolean).length ?? 0;
    const plannerCoordinationPreview = truncateText(
      activeCoordinationBrief?.coordinationNotes.filter(Boolean).join(" ") ?? "",
      170,
    );
    const plannerRiskPreview = truncateText(activeCoordinationBrief?.risks.filter(Boolean).join(" ") ?? "", 170);
    const coordinationFindingCount = coordinationState?.findingSummaries.length ?? 0;
    const coordinationActionRequestCount = coordinationState?.actionRequests.length ?? 0;
    const coordinationFindingPreview = coordinationState?.findingSummaries.slice(0, 4) ?? [];
    const coordinationActionRequestPreview = coordinationState?.actionRequests.slice(0, 4) ?? [];
    const compactExecutionRootLabel = focusedExecutionRoot
      ? truncateText(focusedExecutionRoot.replace(/\\/g, "/"), 72)
      : "Run path not set";

    return (
      <section className="thread-surface panel-tone-home">
        <section
          className={`thread-section-card workspace-context-summary ${
            workspaceContextExpanded ? "workspace-context-expanded-state" : "workspace-context-collapsed-state"
          }`}
        >
          <div className={workspaceContextExpanded ? "dock-subheader" : "workspace-context-inline-row"}>
            {workspaceContextExpanded ? <strong>Run context</strong> : null}
            <div className="compact-notices">
              <span className="compact-note" title={focusedExecutionRoot || "No execution path configured"}>
                {compactExecutionRootLabel}
              </span>
              <span className="compact-note">{sharedContextAvailable ? "Shared context on" : "Shared context off"}</span>
              {contextPackCount > 0 ? (
                <span className="compact-note">
                  {contextPackCount} pack{contextPackCount === 1 ? "" : "s"}
                </span>
              ) : null}
              <span className="compact-note">
                {plannerGuidanceActive ? "Coordination active" : "No coordination brief"}
              </span>
              <span className={coordinationActionRequestCount > 0 ? "compact-note compact-note-warning" : "compact-note"}>
                {coordinationFindingCount} finding{coordinationFindingCount === 1 ? "" : "s"} ·{" "}
                {coordinationActionRequestCount} request{coordinationActionRequestCount === 1 ? "" : "s"}
              </span>
              {workspaceCoordinationState?.teamAsk?.synthesisWarning && (
                <span
                  className="compact-note compact-note-warning"
                  title={workspaceCoordinationState.teamAsk.synthesisWarning}
                  style={{ cursor: "default" }}
                >
                  {"⚠ Synthesis: " + workspaceCoordinationState.teamAsk.synthesisWarning}
                </span>
              )}
              {totalTokens > 0 && (
                <div className="workspace-usage-popover-anchor">
                  <button
                    className={usageBreakdownOpen ? "compact-note workspace-usage-pill workspace-usage-pill-active" : "compact-note workspace-usage-pill"}
                    onClick={() => setUsageBreakdownOpen((o) => !o)}
                    type="button"
                    title="Click to see per-agent breakdown"
                  >
                    {totalTokens >= 1_000_000
                      ? `${(totalTokens / 1_000_000).toFixed(1)}M tok`
                      : totalTokens >= 1_000
                        ? `${(totalTokens / 1_000).toFixed(1)}k tok`
                        : `${totalTokens} tok`}
                    {totalCost > 0 && ` · $${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}`}
                    {" ▾"}
                  </button>
                  {usageBreakdownOpen && (
                    <div className="workspace-usage-dropdown">
                      <div className="workspace-usage-dropdown-header">
                        <span>Agent</span>
                        <span>Tokens (in / out)</span>
                        <span>Cost</span>
                      </div>
                      {agents
                        .filter((a) => a.usage.totalInputTokens + a.usage.totalOutputTokens > 0)
                        .sort((a, b) => b.usage.totalCostUsd - a.usage.totalCostUsd)
                        .map((a) => {
                          const tok = a.usage.totalInputTokens + a.usage.totalOutputTokens;
                          const cost = a.usage.totalCostUsd;
                          const tokLabel =
                            tok >= 1_000_000
                              ? `${(tok / 1_000_000).toFixed(2)}M`
                              : tok >= 1_000
                                ? `${(tok / 1_000).toFixed(1)}k`
                                : `${tok}`;
                          const inLabel = a.usage.totalInputTokens >= 1_000
                            ? `${(a.usage.totalInputTokens / 1_000).toFixed(1)}k`
                            : `${a.usage.totalInputTokens}`;
                          const outLabel = a.usage.totalOutputTokens >= 1_000
                            ? `${(a.usage.totalOutputTokens / 1_000).toFixed(1)}k`
                            : `${a.usage.totalOutputTokens}`;
                          return (
                            <div key={a.id} className="workspace-usage-dropdown-row">
                              <span className="workspace-usage-dropdown-name" title={a.title}>{a.title}</span>
                              <span className="workspace-usage-dropdown-tokens">{tokLabel} <span className="workspace-usage-dropdown-split">({inLabel} / {outLabel})</span></span>
                              <span className="workspace-usage-dropdown-cost">
                                {cost > 0
                                  ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`
                                  : "—"}
                              </span>
                            </div>
                          );
                        })}
                      {(() => {
                        const cu = workspaceCoordinationState?.coordinatorUsage;
                        if (!cu || (cu.inputTokens + cu.outputTokens) === 0) return null;
                        const tok = cu.inputTokens + cu.outputTokens;
                        const tokLabel = tok >= 1_000_000 ? `${(tok / 1_000_000).toFixed(2)}M` : tok >= 1_000 ? `${(tok / 1_000).toFixed(1)}k` : `${tok}`;
                        const inLabel = cu.inputTokens >= 1_000 ? `${(cu.inputTokens / 1_000).toFixed(1)}k` : `${cu.inputTokens}`;
                        const outLabel = cu.outputTokens >= 1_000 ? `${(cu.outputTokens / 1_000).toFixed(1)}k` : `${cu.outputTokens}`;
                        return (
                          <div className="workspace-usage-dropdown-row" style={{ borderTop: "1px solid var(--line)", opacity: 0.8 }}>
                            <span className="workspace-usage-dropdown-name" title={`Coordinator (Haiku) — ${cu.callCount} synthesis call${cu.callCount === 1 ? "" : "s"}`}>
                              Coordinator (Haiku)
                            </span>
                            <span className="workspace-usage-dropdown-tokens">{tokLabel} <span className="workspace-usage-dropdown-split">({inLabel} / {outLabel})</span></span>
                            <span className="workspace-usage-dropdown-cost">
                              {cu.costUsd > 0 ? `$${cu.costUsd < 0.01 ? cu.costUsd.toFixed(4) : cu.costUsd.toFixed(2)}` : "—"}
                            </span>
                          </div>
                        );
                      })()}
                      <div className="workspace-usage-dropdown-total">
                        <span>Total</span>
                        <span>{totalTokens >= 1_000 ? `${(totalTokens / 1_000).toFixed(1)}k` : totalTokens}</span>
                        <span>{totalCost > 0 ? `$${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}` : "—"}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <button
                className={workspaceContextExpanded ? "chip chip-active" : "chip"}
                onClick={() => setWorkspaceContextExpanded((current) => !current)}
                type="button"
              >
                {workspaceContextExpanded ? "Hide" : "Inspect"}
              </button>
            </div>
          </div>
          {workspaceContextExpanded ? (
            <div className="workspace-context-expanded">
              <div className="compact-notices">
                <span className="compact-note" title={workspaceData?.workspace.projectRoot || "No workspace root configured"}>
                  Workspace root: {workspaceData?.workspace.projectRoot || "not set"}
                </span>
                <span className="compact-note" title={focusedExecutionRoot || "No execution path configured"}>
                  Run from: {focusedExecutionRoot || "not set"}
                </span>
                <span className="compact-note">{sharedContextAvailable ? "Shared context attached" : "No shared context"}</span>
                <span className="compact-note">
                  {contextPackCount} context pack{contextPackCount === 1 ? "" : "s"} available
                </span>
              </div>
              <p className="thread-context-note">
                {workspaceFocusedAgent
                  ? `${workspaceFocusedAgent.title} inherits the workspace root and shared brief unless its worktree or working directory overrides them.`
                  : "Broadcasts use the workspace root, shared brief, and active planner guidance for every targeted agent."}
              </p>
              <div className="workspace-context-inspector">
              <article className="workspace-context-preview-card">
                <h4>What every agent inherits</h4>
                <ul className="workspace-context-list">
                  <li>Workspace root: {workspaceData?.workspace.projectRoot || "not set"}</li>
                  <li>Execution path: {focusedExecutionRoot || "not set"}</li>
                  <li>
                    Shared context:{" "}
                    {sharedContextAvailable
                      ? cleanedSharedContextPreview || `${sharedContextWordCount} words available`
                      : "not attached"}
                  </li>
                  <li>Context packs: {contextPackCount} available to mount</li>
                </ul>
              </article>
              <article className="workspace-context-preview-card">
                <h4>Planner orchestration</h4>
                {plannerGuidanceActive ? (
                  <ul className="workspace-context-list">
                    {activeCoordinationBrief?.task ? (
                      <li>Objective: {truncateText(activeCoordinationBrief.task, 180)}</li>
                    ) : null}
                    {activeCoordinationBrief?.constraints ? (
                      <li>Constraints: {truncateText(activeCoordinationBrief.constraints, 180)}</li>
                    ) : null}
                    <li>Summary: {plannerSummaryPreview}</li>
                    <li>
                      Coordination order:{" "}
                      {plannerCoordinationPreview || "No explicit coordination order was provided."}
                    </li>
                    <li>Risks: {plannerRiskPreview || "No explicit risks were provided."}</li>
                  </ul>
                ) : (
                  <p>No active planner guidance is being appended to agent runs right now.</p>
                )}
              </article>
              <article className="workspace-context-preview-card">
                <h4>Shared findings</h4>
                {coordinationFindingPreview.length > 0 ? (
                  <ul className="workspace-context-list">
                    {coordinationFindingPreview.map((finding) => (
                      <li key={finding.id}>
                        <strong>{finding.agentTitle}:</strong> {finding.summary}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No shared findings yet. Agent discoveries will accumulate here for the whole team.</p>
                )}
              </article>
              <article className="workspace-context-preview-card">
                <h4>Open coordination requests</h4>
                {coordinationActionRequestPreview.length > 0 ? (
                  <ul className="workspace-context-list">
                    {coordinationActionRequestPreview.map((request) => (
                      <li key={request.id}>
                        <strong>{request.agentTitle}:</strong> {request.summary}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No open coordination requests right now.</p>
                )}
              </article>
              <article className="workspace-context-preview-card">
                <h4>Usage &amp; cost</h4>
                {totalTokens > 0 ? (
                  <>
                    <ul className="workspace-context-list">
                      <li>
                        Total tokens:{" "}
                        <strong>
                          {(overview?.usageSummary.totalInputTokens ?? 0).toLocaleString()} in ·{" "}
                          {(overview?.usageSummary.totalOutputTokens ?? 0).toLocaleString()} out
                        </strong>
                      </li>
                      <li>
                        Estimated cost:{" "}
                        <strong>
                          {totalCost < 0.0001
                            ? "< $0.0001"
                            : `$${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}`}
                        </strong>
                      </li>
                    </ul>
                    <ul className="workspace-context-list workspace-usage-agent-breakdown">
                      {agents
                        .filter((a) => a.usage.totalInputTokens + a.usage.totalOutputTokens > 0)
                        .sort((a, b) => b.usage.totalCostUsd - a.usage.totalCostUsd)
                        .map((a) => {
                          const agentTokens = a.usage.totalInputTokens + a.usage.totalOutputTokens;
                          const agentCost = a.usage.totalCostUsd;
                          return (
                            <li key={a.id}>
                              <strong>{a.title}</strong>
                              {" — "}
                              {agentTokens >= 1_000
                                ? `${(agentTokens / 1_000).toFixed(1)}k tok`
                                : `${agentTokens} tok`}
                              {agentCost > 0 &&
                                ` · $${agentCost < 0.01 ? agentCost.toFixed(4) : agentCost.toFixed(2)}`}
                            </li>
                          );
                        })}
                    </ul>
                  </>
                ) : (
                  <p>No token usage recorded yet. Usage accumulates as agents run.</p>
                )}
              </article>
              </div>
            </div>
          ) : null}
        </section>

        <section className="workspace-thread-main">
          <div className="thread-mode-tabs">
            <div className="thread-mode-tabs-group">
              <button
                className={workspaceThreadTab === "conversation" ? "chip chip-active workspace-thread-tab-chip" : "chip workspace-thread-tab-chip"}
                onClick={() => setWorkspaceThreadTab("conversation")}
                type="button"
              >
                Conversation
              </button>
              <button
                className={workspaceThreadTab === "audit" ? "chip chip-active workspace-thread-tab-chip" : "chip workspace-thread-tab-chip"}
                onClick={() => setWorkspaceThreadTab("audit")}
                type="button"
              >
                {workspaceAuditErrorCount > 0 ? `Audit ${workspaceAuditErrorCount}` : "Audit"}
              </button>
            </div>
          </div>

          {workspaceThreadTab === "conversation" ? (
            <div
              ref={setWorkspaceConversationContainer}
              className="thread-stream workspace-conversation-stream"
            >
            {workspaceConversationGroups.length > 0 ? (
              workspaceConversationGroups.map((group) => {
                const visibleCoordinationQueue = group.teamAsk
                  ? group.coordinationQueue.filter(
                      (queueItem) =>
                        queueItem.kind !== "needs_input" || !group.teamAsk?.agentIds.includes(queueItem.agentId),
                    )
                  : group.coordinationQueue;
                const teamAskSupplementalQueue = group.teamAsk
                  ? visibleCoordinationQueue.filter((queueItem) => queueItem.kind !== "needs_input")
                  : [];
                // Include both WAITING_INPUT agents (needsInput) and ERROR agents in the team ask
                // so the operator can see which agents need attention and which have errored.
                const teamAskAgentThreads = group.teamAsk
                  ? group.agentThreads.filter(
                      (agentThread) =>
                        group.teamAsk?.agentIds.includes(agentThread.agentId) &&
                        (agentThread.needsInput || agentThread.agentState === "ERROR"),
                    )
                  : [];

                return (
                <section key={group.prompt.id} className="workspace-prompt-group">
                  <article className="thread-message thread-message-user workspace-prompt-bubble">
                    <div className="event-item-header">
                      <strong>{group.prompt.title}</strong>
                      <span>{formatEventTimestamp(group.prompt.ts)}</span>
                    </div>
                    <div className="thread-message-markdown">{renderMarkdownBlocks(group.prompt.content)}</div>
                    <div className="compact-notices">
                      <span className="compact-note">
                        {group.prompt.scope === "agent"
                          ? workspaceFocusedAgent?.title ?? "Focused agent"
                          : `${group.targetCount} target${group.targetCount === 1 ? "" : "s"}`}
                      </span>
                    </div>
                  </article>

                  {group.coordinationFindings.length > 0 ? (() => {
                    const MAX_FINDINGS_COLLAPSED = 3;
                    const findings = group.coordinationFindings;
                    const isFindingsExpanded = findingsExpanded[group.prompt.id] ?? false;
                    const visibleFindings = isFindingsExpanded ? findings : findings.slice(0, MAX_FINDINGS_COLLAPSED);
                    const hiddenCount = findings.length - visibleFindings.length;
                    return (
                    <div className="workspace-team-findings">
                      <div className="workspace-team-findings-header">
                        <strong>Team findings</strong>
                        <span>{group.coordinationFindings.length}</span>
                      </div>
                      <div className="workspace-team-findings-list">
                        {visibleFindings.map((finding) => {
                          const SUMMARY_LIMIT = 280;
                          const isFindingExpanded = expandedFindingCards[finding.id] ?? false;
                          const summaryNeedsExpand = (finding.summary?.length ?? 0) > SUMMARY_LIMIT;
                          const displaySummary =
                            summaryNeedsExpand && !isFindingExpanded
                              ? `${finding.summary.slice(0, SUMMARY_LIMIT)}…`
                              : finding.summary;
                          return (
                          <article key={finding.id} className="workspace-team-finding">
                            <div className="event-item-header">
                              <strong>{finding.agentTitle}</strong>
                              <span>{formatEventTimestamp(finding.ts)}</span>
                            </div>
                            <div className="compact-notices">
                              <span className="compact-note workspace-finding-type-chip">
                                {formatWorkspaceFindingTypeLabel(finding.findingType)}
                              </span>
                            </div>
                            <p className="workspace-finding-summary">{displaySummary}</p>
                            {finding.detail && isFindingExpanded ? (
                              <p className="thread-message-detail workspace-finding-detail">{finding.detail}</p>
                            ) : null}
                            {(summaryNeedsExpand || (finding.detail && !isFindingExpanded)) ? (
                              <button
                                className="workspace-finding-expand-btn"
                                onClick={() =>
                                  setExpandedFindingCards((current) => ({
                                    ...current,
                                    [finding.id]: !isFindingExpanded,
                                  }))
                                }
                                type="button"
                              >
                                {isFindingExpanded ? "Show less" : "Read more"}
                              </button>
                            ) : null}
                          </article>
                          );
                        })}
                      </div>
                      {findings.length > MAX_FINDINGS_COLLAPSED ? (
                        <button
                          className="workspace-findings-toggle"
                          onClick={() =>
                            setFindingsExpanded((current) => ({
                              ...current,
                              [group.prompt.id]: !isFindingsExpanded,
                            }))
                          }
                          type="button"
                        >
                          {isFindingsExpanded ? "Show less" : `Show ${hiddenCount} more`}
                        </button>
                      ) : null}
                    </div>
                    );
                  })() : null}

                  {!workspaceFocusedAgent && visibleCoordinationQueue.length > 0 ? (
                    <section className="workspace-coordination-queue">
                      <div className="workspace-team-findings-header">
                        <strong>Coordination queue</strong>
                        <span>{visibleCoordinationQueue.length}</span>
                      </div>
                      <div className="workspace-coordination-queue-list">
                        {visibleCoordinationQueue.map((queueItem) => (
                          <article
                            key={queueItem.id}
                            className="thread-message thread-message-warning workspace-inline-action-card workspace-coordination-queue-item"
                          >
                            <div className="workspace-inline-action-header">
                              <strong>{queueItem.agentTitle}</strong>
                              <span>{formatEventTimestamp(queueItem.ts)}</span>
                            </div>
                            <div className="compact-notices">
                              <span className="compact-note compact-note-warning">
                                {queueItem.kind === "approval"
                                  ? "Approval required"
                                  : queueItem.kind === "handoff_follow_up"
                                    ? "Follow-up ready"
                                    : "Needs your reply"}
                              </span>
                              {queueItem.kind === "approval" && (() => {
                                const ageMinutes = Math.floor((Date.now() - new Date(queueItem.ts).getTime()) / 60_000);
                                return ageMinutes >= 2 ? (
                                  <span className="approval-overdue-badge">{ageMinutes}m waiting</span>
                                ) : null;
                              })()}
                            </div>
                            <div className="thread-message-markdown workspace-action-request-copy">
                              {renderMarkdownBlocks(queueItem.content)}
                            </div>
                            {queueItem.detail ? <p className="thread-message-detail">{queueItem.detail}</p> : null}

                            {queueItem.kind === "approval" && queueItem.approval ? (
                              <div className="settings-actions">
                                <button
                                  className="outline-button outline-button-small success-button"
                                  onClick={() => void handleApprove(queueItem.approval!.id)}
                                  type="button"
                                >
                                  Approve
                                </button>
                                <button
                                  className="outline-button outline-button-small danger-button"
                                  onClick={() => void handleDeny(queueItem.approval!.id)}
                                  type="button"
                                >
                                  Deny
                                </button>
                                <button
                                  className="outline-button outline-button-small"
                                  onClick={() => focusWorkspaceAgent(queueItem.agentId)}
                                  type="button"
                                >
                                  Reply separately
                                </button>
                              </div>
                            ) : null}

                            {queueItem.kind === "needs_input" ? (
                              <>
                                <textarea
                                  className="settings-textarea thread-inline-reply-textarea"
                                  value={inlineAgentReplyDrafts[queueItem.agentId] ?? ""}
                                  onChange={(event) =>
                                    setInlineAgentReplyDrafts((current) => ({
                                      ...current,
                                      [queueItem.agentId]: event.target.value,
                                    }))
                                  }
                                  placeholder={`Reply to ${queueItem.agentTitle} right here…`}
                                  rows={3}
                                />
                                <div className="settings-actions">
                                  <button
                                    className="outline-button success-button"
                                    disabled={
                                      broadcastPending || !(inlineAgentReplyDrafts[queueItem.agentId]?.trim().length)
                                    }
                                    onClick={() => void handleInlineWorkspaceReply(queueItem.agentId)}
                                    type="button"
                                  >
                                    {broadcastPending ? "Sending..." : `Reply to ${queueItem.agentTitle}`}
                                  </button>
                                  <button
                                    className="outline-button outline-button-small"
                                    onClick={() => focusWorkspaceAgent(queueItem.agentId)}
                                    type="button"
                                  >
                                    Reply separately
                                  </button>
                                </div>
                              </>
                            ) : null}

                            {queueItem.kind === "handoff_follow_up" && queueItem.handoff ? (
                              <div className="settings-actions">
                                <button
                                  className="outline-button outline-button-small"
                                  onClick={() => focusRun(queueItem.handoff!.sourceAgentId, queueItem.handoff!.sourceRunId)}
                                  type="button"
                                >
                                  Open run
                                </button>
                                <button
                                  className="outline-button outline-button-small"
                                  onClick={() => void handleCreateAgentFromInbox(queueItem.handoff!.id)}
                                  type="button"
                                >
                                  Create follow-up
                                </button>
                                <button
                                  className="outline-button outline-button-small"
                                  onClick={() => void handleUpdateInboxStatus(queueItem.handoff!.id, "DONE")}
                                  type="button"
                                >
                                  Done
                                </button>
                                <button
                                  className="outline-button outline-button-small danger-button"
                                  onClick={() => void handleUpdateInboxStatus(queueItem.handoff!.id, "DISMISSED")}
                                  type="button"
                                >
                                  Dismiss
                                </button>
                              </div>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  <div className="workspace-thread-nest">
                    {group.agentThreads.length > 0 ? (
                      <div className="workspace-prompt-replies">
                        {group.agentThreads.map((agentThread) => {
                          const latestReply = [...agentThread.replies]
                            .reverse()
                            .find((reply) => reply.kind === "reply" || reply.kind === "error") ?? null;
                          const explicitAgentAsk =
                            [...agentThread.replies].reverse().find((reply) => reply.kind === "needs_input") ?? null;
                          const actionRequestCopy =
                            agentThread.needsInputRequest ??
                            getWorkspaceActionRequestCopy(
                              agentThread.agentTitle,
                              latestReply,
                              explicitAgentAsk,
                            );
                          const visibleReplies = workspaceFocusedAgent
                            ? agentThread.replies
                            : agentThread.replies.filter((reply) => reply.kind !== "needs_input");
                          const isCoveredByTeamAsk = Boolean(
                            !workspaceFocusedAgent && group.teamAsk?.agentIds.includes(agentThread.agentId),
                          );
                          const showInlineAgentActions = Boolean(workspaceFocusedAgent) && !isCoveredByTeamAsk;
                          const hasQueueItem = group.coordinationQueue.some(
                            (queueItem) => queueItem.agentId === agentThread.agentId,
                          );

                          const agentMeta = agents.find((a) => a.id === agentThread.agentId)?.metadata;
                          const isSpawnedAgent = typeof agentMeta?.spawnedBy === "string";
                          const spawnDepth = typeof agentMeta?.spawnDepth === "number" ? agentMeta.spawnDepth : 0;

                          return (
                            <section key={`${group.prompt.id}-${agentThread.agentId}`} className="workspace-agent-thread">
                              <div className="workspace-agent-thread-header">
                                <div className="workspace-agent-thread-title">
                                  <strong>{agentThread.agentTitle}</strong>
                                  {isSpawnedAgent && (
                                    <span
                                      className="compact-note"
                                      style={{ opacity: 0.7, fontSize: "0.72em" }}
                                      title={`Sub-agent spawned by ${String(agentMeta?.spawnedBy ?? "another agent")} (depth ${spawnDepth})`}
                                    >
                                      ⤷ L{spawnDepth}
                                    </span>
                                  )}
                                  <div className="compact-notices">
                                    {latestReply ? (
                                      <span
                                        className={`compact-note ${
                                          latestReply.kind === "error"
                                            ? "compact-note-danger"
                                            : latestReply.streaming
                                              ? "compact-note-info"
                                              : "compact-note-success"
                                        }`}
                                      >
                                        {latestReply.kind === "error"
                                          ? "Error"
                                          : latestReply.streaming
                                            ? "Streaming…"
                                            : "Reply"}
                                      </span>
                                    ) : null}
                                    {agentThread.needsInput && !isCoveredByTeamAsk ? (
                                      <span className="compact-note compact-note-warning">Needs your reply</span>
                                    ) : null}
                                    {isCoveredByTeamAsk ? (
                                      <span className="compact-note compact-note-info">Reply handled in team ask</span>
                                    ) : null}
                                    {agentThread.approvals.length > 0 ? (
                                      <span className="compact-note compact-note-warning">
                                        {agentThread.approvals.length} approval{agentThread.approvals.length === 1 ? "" : "s"}
                                      </span>
                                    ) : null}
                                    {agentThread.handoffs.length > 0 ? (
                                      <span className="compact-note compact-note-info">
                                        {agentThread.handoffs.length} follow-up{agentThread.handoffs.length === 1 ? "" : "s"}
                                      </span>
                                    ) : null}
                                    {!workspaceFocusedAgent && hasQueueItem && !isCoveredByTeamAsk ? (
                                      <span className="compact-note compact-note-warning">Action below</span>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="settings-actions workspace-agent-thread-actions">
                                  <span>{formatEventTimestamp(agentThread.latestTs)}</span>
                                  {!workspaceFocusedAgent ? (
                                    <button
                                      className="outline-button outline-button-small"
                                      onClick={() => focusWorkspaceAgent(agentThread.agentId)}
                                      type="button"
                                    >
                                      Focus
                                    </button>
                                  ) : null}
                                </div>
                              </div>

                              <div className="workspace-agent-thread-body">
                                {visibleReplies.length > 0 ? (
                                  visibleReplies.map((reply) => (
                                    (() => {
                                      const expandable = shouldCollapseWorkspaceReply(reply);
                                      const expanded = expandedWorkspaceReplies[reply.id] ?? false;
                                      const showDetail = Boolean(reply.detail) && !isDuplicateLike(reply.content, reply.detail);

                                      return (
                                        <article
                                          key={reply.id}
                                          className={`thread-message workspace-reply-bubble ${
                                            reply.kind === "error"
                                              ? "thread-message-danger"
                                              : reply.kind === "rate_limit" || reply.kind === "needs_input"
                                                ? "thread-message-warning"
                                                : "thread-message-assistant"
                                          }`}
                                        >
                                          <div className="event-item-header">
                                            <span>{formatEventTimestamp(reply.ts)}</span>
                                          </div>
                                          <div
                                            className={
                                              expandable && !expanded
                                                ? "workspace-reply-content workspace-reply-content-collapsed"
                                                : "workspace-reply-content"
                                            }
                                          >
                                            <div className="thread-message-markdown">{renderMarkdownBlocks(reply.content)}</div>
                                            {showDetail ? <p className="thread-message-detail">{reply.detail}</p> : null}
                                          </div>
                                          {expandable ? (
                                            <button
                                              className="workspace-reply-toggle"
                                              onClick={() =>
                                                setExpandedWorkspaceReplies((current) => ({
                                                  ...current,
                                                  [reply.id]: !expanded,
                                                }))
                                              }
                                              type="button"
                                            >
                                              {expanded ? "Show less" : "Show more"}
                                            </button>
                                          ) : null}
                                          {reply.kind === "rate_limit" && reply.prompt ? (
                                            <button
                                              className="outline-button outline-button-small"
                                              onClick={() =>
                                                void createRunMutation.mutateAsync({
                                                  agentId: reply.agentId,
                                                  prompt: reply.prompt!,
                                                })
                                              }
                                              type="button"
                                            >
                                              Retry
                                            </button>
                                          ) : null}
                                        </article>
                                      );
                                    })()
                                  ))
                                ) : agentThread.needsInput ? (
                                  <div className="panel-empty panel-empty-inline">
                                    {isCoveredByTeamAsk
                                      ? `${agentThread.agentTitle} is included in the shared team ask below.`
                                      : `${agentThread.agentTitle} is waiting for your reply.`}
                                  </div>
                                ) : null}

                                {showInlineAgentActions && agentThread.approvals.length > 0 ? (
                                  <div className="workspace-agent-thread-actions-list">
                                    {agentThread.approvals.map((reply) => (
                                      <article
                                        key={reply.id}
                                        className="thread-message thread-message-warning workspace-inline-action-card"
                                      >
                                        <div className="event-item-header">
                                          <strong>Approval required</strong>
                                          {(() => {
                                            const ageMinutes = Math.floor((Date.now() - new Date(reply.ts).getTime()) / 60_000);
                                            return ageMinutes >= 2 ? (
                                              <span className="approval-overdue-badge">{ageMinutes}m waiting</span>
                                            ) : null;
                                          })()}
                                          <span>{formatEventTimestamp(reply.ts)}</span>
                                        </div>
                                        <div className="thread-message-markdown">{renderMarkdownBlocks(reply.content)}</div>
                                        {reply.detail ? <p className="thread-message-detail">{reply.detail}</p> : null}
                                        {reply.approval ? (
                                          <div className="settings-actions">
                                            <button
                                              className="outline-button outline-button-small success-button"
                                              onClick={() => void handleApprove(reply.approval!.id)}
                                              type="button"
                                            >
                                              Approve
                                            </button>
                                            <button
                                              className="outline-button outline-button-small danger-button"
                                              onClick={() => void handleDeny(reply.approval!.id)}
                                              type="button"
                                            >
                                              Deny
                                            </button>
                                          </div>
                                        ) : null}
                                      </article>
                                    ))}
                                  </div>
                                ) : null}

                                {showInlineAgentActions && agentThread.needsInput ? (
                                  <div className="thread-inline-reply workspace-inline-action-card">
                                    <div className="workspace-inline-action-header">
                                      <strong>{agentThread.agentTitle} needs your reply</strong>
                                      <span>{formatEventTimestamp(agentThread.latestTs)}</span>
                                    </div>
                                    <div className="thread-message-markdown workspace-action-request-copy">
                                      {renderMarkdownBlocks(actionRequestCopy.content)}
                                    </div>
                                    <p className="thread-message-detail">{actionRequestCopy.detail}</p>
                                    <textarea
                                      className="settings-textarea thread-inline-reply-textarea"
                                      value={inlineAgentReplyDrafts[agentThread.agentId] ?? ""}
                                      onChange={(event) =>
                                        setInlineAgentReplyDrafts((current) => ({
                                          ...current,
                                          [agentThread.agentId]: event.target.value,
                                        }))
                                      }
                                      placeholder={`Reply to ${agentThread.agentTitle} right here…`}
                                      rows={3}
                                    />
                                    <div className="settings-actions">
                                      <button
                                        className="outline-button success-button"
                                        disabled={
                                          broadcastPending || !(inlineAgentReplyDrafts[agentThread.agentId]?.trim().length)
                                        }
                                        onClick={() => void handleInlineWorkspaceReply(agentThread.agentId)}
                                        type="button"
                                      >
                                        {broadcastPending ? "Sending..." : `Send to ${agentThread.agentTitle}`}
                                      </button>
                                    </div>
                                  </div>
                                ) : null}

                                {showInlineAgentActions && agentThread.handoffs.length > 0 ? (
                                  <div className="workspace-handoff-list">
                                    {agentThread.handoffs.map((handoff) => (
                                      <article
                                        key={handoff.id}
                                        className="thread-message thread-message-info workspace-handoff-card"
                                      >
                                        <div className="event-item-header">
                                          <strong>{handoff.title}</strong>
                                          <span>{handoff.status.toLowerCase()}</span>
                                        </div>
                                        <p>{handoff.summary}</p>
                                        <div className="compact-notices">
                                          <span className="compact-note">
                                            {handoff.recommendedProvider}/{handoff.recommendedModel}
                                          </span>
                                          <span className="compact-note">
                                            {handoff.artifactIds.length} artifact{handoff.artifactIds.length === 1 ? "" : "s"}
                                          </span>
                                        </div>
                                        <p className="thread-message-detail">{truncateText(handoff.nextPrompt, 220)}</p>
                                        <div className="settings-actions">
                                          <button
                                            className="outline-button outline-button-small"
                                            onClick={() => focusRun(handoff.sourceAgentId, handoff.sourceRunId)}
                                            type="button"
                                          >
                                            Open run
                                          </button>
                                          <button
                                            className="outline-button outline-button-small"
                                            onClick={() => void handleCreateAgentFromInbox(handoff.id)}
                                            type="button"
                                          >
                                            Create follow-up
                                          </button>
                                          {workspaceFocusedAgent && handoff.assignedAgentId !== workspaceFocusedAgent.id ? (
                                            <button
                                              className="outline-button outline-button-small"
                                              onClick={() => void handleAssignInbox(handoff.id, workspaceFocusedAgent.id)}
                                              type="button"
                                            >
                                              Assign to {workspaceFocusedAgent.title}
                                            </button>
                                          ) : null}
                                          <button
                                            className="outline-button outline-button-small"
                                            onClick={() => void handleUpdateInboxStatus(handoff.id, "DONE")}
                                            type="button"
                                          >
                                            Done
                                          </button>
                                          <button
                                            className="outline-button outline-button-small danger-button"
                                            onClick={() => void handleUpdateInboxStatus(handoff.id, "DISMISSED")}
                                            type="button"
                                          >
                                            Dismiss
                                          </button>
                                        </div>
                                      </article>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="panel-empty panel-empty-inline">
                        Waiting for {group.targetCount} agent reply{group.targetCount === 1 ? "" : "ies"}.
                      </div>
                    )}

                    {!workspaceFocusedAgent && group.teamAsk ? (
                      <section className="workspace-team-ask">
                        <article className="thread-message thread-message-warning workspace-inline-action-card workspace-team-ask-card">
                          <div className="workspace-inline-action-header">
                            <strong>Agent Command Center needs your guidance</strong>
                            {group.teamAsk.synthesized && (
                              <span className="synthesis-badge">AI summary</span>
                            )}
                            <span>{formatEventTimestamp(group.teamAsk.ts)}</span>
                          </div>
                          <div className="compact-notices">
                            <span className="compact-note compact-note-warning">
                              {group.teamAsk.agentIds.length} agent{group.teamAsk.agentIds.length === 1 ? "" : "s"} waiting
                            </span>
                            <span className="compact-note">
                              {group.teamAsk.requestIds.length} ask{group.teamAsk.requestIds.length === 1 ? "" : "s"}
                            </span>
                            <span className="compact-note">
                              {group.teamAsk.recommendedResponseShape === "approval"
                                ? "Needs approval"
                                : group.teamAsk.recommendedResponseShape === "input"
                                  ? "Needs your input"
                                  : group.teamAsk.recommendedResponseShape === "confirmation"
                                    ? "Needs confirmation"
                                    : "Needs direction"}
                            </span>
                          </div>
                          {/* Only show the summary block when it adds something beyond the per-agent rows:
                              - synthesized = LLM produced a unique unified headline
                              - agentIds.length > 1 = count sentence is useful context
                              For a single un-synthesized agent the per-agent row already shows the content. */}
                          {(group.teamAsk.synthesized || group.teamAsk.agentIds.length > 1) ? (
                            <div className="thread-message-markdown workspace-action-request-copy">
                              {renderMarkdownBlocks(group.teamAsk.summary)}
                            </div>
                          ) : null}
                          {group.teamAsk.detail && !isDuplicateLike(group.teamAsk.summary, group.teamAsk.detail) ? (
                            <p className="thread-message-detail">{group.teamAsk.detail}</p>
                          ) : null}
                          {group.teamAsk.blockedBranches.length > 0 ? (
                            <div className="workspace-team-ask-blocked-branches">
                              <p className="thread-message-detail workspace-team-ask-blocked-label">Blocked branches:</p>
                              <ul className="workspace-team-ask-blocked-list">
                                {group.teamAsk.blockedBranches.map((branch) => (
                                  <li key={branch.agentId} className="workspace-team-ask-blocked-item">
                                    <strong>{branch.agentTitle}</strong>
                                    <span>{branch.blockedReason}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          <p className="thread-message-detail workspace-team-ask-detail">
                            Reply once in the composer below and ACC will route that guidance to the waiting agents. Focus
                            one agent only if you want to give a custom answer.
                          </p>
                          {teamAskAgentThreads.length > 0 ? (
                            <div className="workspace-team-ask-list">
                              {teamAskAgentThreads.map((agentThread) => {
                                const latestReply = [...agentThread.replies]
                                  .reverse()
                                  .find((reply) => reply.kind === "reply" || reply.kind === "error") ?? null;
                                const explicitAgentAsk =
                                  [...agentThread.replies].reverse().find((reply) => reply.kind === "needs_input") ?? null;
                                const actionRequestCopy =
                                  agentThread.needsInputRequest ??
                                  getWorkspaceActionRequestCopy(
                                    agentThread.agentTitle,
                                    latestReply,
                                    explicitAgentAsk,
                                  );

                                const isAgentErrored = agentThread.agentState === "ERROR";
                                const errorReply = isAgentErrored
                                  ? [...agentThread.replies].reverse().find((r) => r.kind === "error" || r.kind === "rate_limit") ?? null
                                  : null;

                                return (
                                  <div
                                    key={`team-ask-${group.prompt.id}-${agentThread.agentId}`}
                                    className={`workspace-team-ask-agent${isAgentErrored ? " workspace-team-ask-agent-error" : ""}`}
                                  >
                                    <div className="workspace-team-ask-agent-meta">
                                      <strong>
                                        {agentThread.agentTitle}
                                        {isAgentErrored && (
                                          <span className="agent-error-badge">Error</span>
                                        )}
                                      </strong>
                                      {isAgentErrored ? (
                                        <span className="workspace-team-ask-agent-error-msg">
                                          {errorReply?.content ?? "Agent stopped with an error. Focus the agent to retry."}
                                        </span>
                                      ) : (
                                        <span>{actionRequestCopy.content}</span>
                                      )}
                                    </div>
                                    <button
                                      className="outline-button outline-button-small"
                                      onClick={() => focusWorkspaceAgent(agentThread.agentId)}
                                      type="button"
                                    >
                                      {isAgentErrored ? "Focus & retry" : "Reply separately"}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                          <div className="workspace-team-ask-footer">
                            <button
                              className="outline-button outline-button-small"
                              onClick={() => {
                                if (activeWorkspaceId) {
                                  dismissTeamAskMutation.mutate(activeWorkspaceId);
                                }
                              }}
                              disabled={dismissTeamAskMutation.isPending}
                              type="button"
                            >
                              Dismiss
                            </button>
                          </div>
                          {/* Follow-up / handoff items are shown in the coordination queue
                              section above the thread nest — not duplicated here. */}
                        </article>
                      </section>
                    ) : null}

                    {group.pendingAgentTitles.length > 0 ? (
                      <div className="panel-empty panel-empty-inline">
                        Still waiting on {group.pendingAgentTitles.join(", ")}.
                      </div>
                    ) : null}
                  </div>
                </section>
                );
              })
            ) : (
              <div className="panel-empty">
                {workspaceFocusedAgent
                  ? `No conversation yet for ${focusedAgentTitle}. Send a focused instruction below to start the thread and keep the exchange here in Workspace.`
                  : "Start here. Send a workspace instruction and agent replies will appear here as a single conversation thread."}
              </div>
            )}
            </div>
          ) : (
            <section className="thread-section-card workspace-live-feed">
            <div className="dock-subheader">
              <strong>{workspaceFocusedAgent ? "Focused audit" : "Workspace audit"}</strong>
              <div className="compact-notices">
                <button
                  className={workspaceLiveFeedFilter === "all" ? "chip chip-active" : "chip"}
                  onClick={() => setWorkspaceLiveFeedFilter("all")}
                  type="button"
                >
                  All
                </button>
                <button
                  className={workspaceLiveFeedFilter === "errors" ? "chip chip-filter-errors chip-active" : "chip chip-filter-errors"}
                  onClick={() => setWorkspaceLiveFeedFilter("errors")}
                  type="button"
                >
                  Errors
                </button>
                <span className="compact-note">
                  {workspaceFocusedAgent
                    ? focusedAgentTitle
                    : `${workspaceAuditFeed.length} ${workspaceLiveFeedFilter === "errors" ? "errors" : "events"}`}
                </span>
                {!workspaceFocusedAgent ? (
                  <button className="outline-button outline-button-small" onClick={() => void workspaceOverviewQuery.refetch()} type="button">
                    Refresh
                  </button>
                ) : null}
              </div>
            </div>
            {workspaceFocusedAgent ? (
              selectedRunApprovals.length > 0 || selectedRunActivity.length > 0 ? (
                <div className="thread-sidebar-stack">
                  {selectedRunApprovals.map((approval) => (
                    <article key={`workspace-approval-${approval.id}`} className="thread-message thread-message-warning">
                      <div className="event-item-header">
                        <strong>{approval.requestedAction}</strong>
                        <span>{formatDateTime(approval.createdAt)}</span>
                      </div>
                      <p>{approval.reason || "The agent requested approval for a risky action."}</p>
                      <div className="compact-notices">
                        <span className="compact-note">{runToolCallById.get(approval.toolCallId)?.status ?? "pending"}</span>
                        {runToolCallById.get(approval.toolCallId)?.requestedCwd ? (
                          <span className="compact-note">{runToolCallById.get(approval.toolCallId)?.requestedCwd}</span>
                        ) : null}
                      </div>
                      <pre className="file-preview-code">{formatJsonPreview(approval.requestedPayload)}</pre>
                      <div className="settings-actions">
                        <button className="outline-button success-button" onClick={() => void handleApprove(approval.id)} type="button">
                          Approve
                        </button>
                        <button className="outline-button danger-button" onClick={() => void handleDeny(approval.id)} type="button">
                          Deny
                        </button>
                      </div>
                    </article>
                  ))}
                  {selectedRunActivity.map((entry) => (
                    <article key={`workspace-audit-${entry.id}`} className="thread-message thread-message-info">
                      <div className="event-item-header">
                        <strong>{entry.entryType === "approval" ? "approval event" : "tool activity"}</strong>
                        <span>{formatEventTimestamp(entry.createdAt)}</span>
                      </div>
                      <div className="thread-message-markdown">{renderMarkdownBlocks(entry.content)}</div>
                      {Object.keys(entry.metadata).length > 0 ? (
                        <pre className="file-preview-code">{formatJsonPreview(entry.metadata)}</pre>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="panel-empty">
                  {workspaceLiveFeedFilter === "errors"
                    ? `No audit errors yet for ${focusedAgentTitle}.`
                    : `No operational audit events yet for ${focusedAgentTitle}.`}
                </div>
              )
            ) : workspaceAuditFeed.length > 0 ? (
              <div className="activity-list activity-list-inline activity-list-workspace">
                {workspaceAuditFeed.map((item) => {
                  const activityAgent = agents.find((agent) => agent.id === item.agentId) ?? null;
                  const canStopAgent = activityAgent
                    ? !["STOPPED", "COMPLETED"].includes(activityAgent.state)
                    : false;

                  return (
                    <article key={`workspace-live-${item.id}`} className={`activity-item activity-item-${item.tone}`}>
                      <button
                        className="activity-item-body-button"
                        onClick={() => focusWorkspaceActivityItem(item)}
                        type="button"
                      >
                        <div className="activity-item-header">
                          <strong title={item.agentTitle}>{item.agentTitle}</strong>
                          <span>{formatEventTimestamp(item.ts)}</span>
                        </div>
                        <div className="activity-item-summary">{item.summary}</div>
                        {item.detail ? <p className="activity-item-detail">{item.detail}</p> : null}
                      </button>
                      <div className="settings-actions activity-item-actions">
                        <button
                          className="outline-button outline-button-small danger-button"
                          disabled={!canStopAgent || stopSelectedAgentMutation.isPending}
                          onClick={() => void handleStopAgentById(item.agentId)}
                          type="button"
                        >
                          Stop
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="panel-empty">
                {workspaceFocusedAgent
                  ? workspaceLiveFeedFilter === "errors"
                    ? `No audit errors yet for ${focusedAgentTitle}.`
                    : `No operational audit events yet for ${focusedAgentTitle}.`
                  : workspaceLiveFeedFilter === "errors"
                    ? "No workspace audit errors yet."
                  : "No operational audit events yet. Tool activity, status changes, and other low-level events will appear here."}
              </div>
            )}
            </section>
          )}

          <div className="thread-composer-shell">
            <div className="settings-field thread-composer-field">
              <textarea
                aria-label={workspaceFocusedAgent ? `Message ${workspaceFocusedAgent.title}` : "Workspace instruction"}
                className="settings-textarea broadcast-textarea"
                value={broadcastInputDraft}
                onChange={(event) => setBroadcastInputDraft(event.target.value)}
                placeholder={
                  workspaceFocusedAgent
                    ? `Message ${workspaceFocusedAgent.title}…`
                    : activeWorkspaceTeamAsk
                      ? "Reply to the team ask here…"
                      : "Ask the fleet to investigate, implement, review, or report back."
                }
                rows={2}
              />
            </div>
            <div className="thread-composer-actions">
              <div className="settings-actions thread-composer-primary-actions">
                <label className="compact-select-field workspace-composer-focus-field">
                  <select
                    className="workspace-picker"
                    value={workspaceFocusedAgentId}
                    onChange={(event) => {
                      const nextAgentId = event.target.value;
                      if (nextAgentId) {
                        focusWorkspaceAgent(nextAgentId);
                        return;
                      }

                      clearWorkspaceAgentFocus();
                    }}
                  >
                    <option value="">All agents</option>
                    {orderedAgents.map((agent) => (
                      <option key={`workspace-focus-composer-${agent.id}`} value={agent.id}>
                        {agent.title}
                      </option>
                    ))}
                  </select>
                </label>
                {workspaceFocusedAgent ? (
                  <span className={`badge badge-${agentStateMeta[workspaceFocusedAgent.state].tone}`}>
                    {agentStateMeta[workspaceFocusedAgent.state].label}
                  </span>
                ) : null}
                {workspaceFocusedAgent ? (
                  <button
                    className="outline-button outline-button-small"
                    onClick={() => clearWorkspaceAgentFocus()}
                    type="button"
                  >
                    Back to all agents
                  </button>
                ) : null}
                <span className="compact-note compact-note-broadcast">
                  {broadcastPending
                    ? `Sending to ${broadcastTargetCount} agent${broadcastTargetCount === 1 ? "" : "s"}...`
                    : workspaceFocusedAgent
                      ? `Target: ${workspaceFocusedAgent.title}`
                      : activeWorkspaceTeamAsk
                        ? `Reply to ${broadcastTargetCount} waiting agent${broadcastTargetCount === 1 ? "" : "s"}`
                      : `Target: ${broadcastTargetCount} agent${broadcastTargetCount === 1 ? "" : "s"}`}
                </span>
                <button
                  className="outline-button success-button broadcast-send-button"
                  disabled={!canBroadcastToAgents || broadcastPending || broadcastTargetCount === 0}
                  onClick={() => void handleBroadcast()}
                  type="button"
                >
                  {broadcastPending ? "Sending..." : "Send"}
                </button>
                <button
                  className="outline-button outline-button-small"
                  onClick={() => {
                    workspaceShouldAutoScrollRef.current = true;
                    scrollWorkspaceConversationToLatest("smooth");
                  }}
                  type="button"
                >
                  Latest
                </button>
              </div>
            </div>
          </div>
        </section>

        {!workspaceFocusedAgent && workspaceRosterExpanded ? (
            <section className="thread-section-card workspace-agent-roster">
              <div className="dock-subheader">
                <strong>Agent roster</strong>
                <div className="compact-notices">
                  <span className="compact-note">{visibleTiles.length} visible</span>
                  <span className="compact-note">{agents.length} total</span>
                  <button
                    className="chip chip-active workspace-thread-tab-chip"
                    onClick={() => setWorkspaceRosterExpanded(false)}
                    type="button"
                  >
                    Hide roster
                  </button>
                </div>
              </div>
              <div className="workspace-agent-roster-list">
                {visibleTiles.map((agent) => {
                  const latestActivity = latestFleetActivityByAgent.get(agent.id);
                  const isSelected = workspaceFocusedAgentId === agent.id;
                  const runLocation = agent.worktree?.path ? "worktree" : "workspace root";
                  const latestActivityLabel = latestActivity
                    ? isFleetOutputEventType(latestActivity.eventType)
                      ? "Latest reply"
                      : latestActivity.summary
                    : "No activity yet";
                  return (
                    <button
                      key={`workspace-agent-${agent.id}`}
                      className={isSelected ? "workspace-agent-item workspace-agent-item-active" : "workspace-agent-item"}
                      onClick={() => focusWorkspaceAgent(agent.id)}
                      type="button"
                    >
                      <div className="workspace-agent-item-main">
                        <div className="workspace-agent-item-head">
                          <strong title={agent.title}>{agent.title}</strong>
                          <span className={`badge badge-${agentStatusOverrides.get(agent.id)?.tone ?? agentStateMeta[agent.state].tone}`}>
                            {agentStatusOverrides.get(agent.id)?.label ?? agentStateMeta[agent.state].label}
                          </span>
                          {agent.state === "WAITING_DEPENDENCY" && (
                            <span className="agent-dep-badge">blocked</span>
                          )}
                        </div>
                        <div className="compact-notices">
                          <span className="compact-note">
                            {agent.provider}/{agent.model}
                          </span>
                          <span className="compact-note" title={agent.worktree?.path ?? workspaceData?.workspace.projectRoot ?? "workspace root"}>
                            {runLocation}
                          </span>
                          {(() => {
                            const tok = agent.usage.totalInputTokens + agent.usage.totalOutputTokens;
                            if (tok === 0) return null;
                            const cost = agent.usage.totalCostUsd;
                            const tokLabel = tok >= 1_000_000
                              ? `${(tok / 1_000_000).toFixed(1)}M tok`
                              : tok >= 1_000
                                ? `${(tok / 1_000).toFixed(1)}k tok`
                                : `${tok} tok`;
                            const costLabel = cost > 0
                              ? ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`
                              : "";
                            return (
                              <span
                                className="compact-note workspace-usage-pill"
                                title={`${agent.usage.totalInputTokens.toLocaleString()} in · ${agent.usage.totalOutputTokens.toLocaleString()} out`}
                              >
                                {tokLabel}{costLabel}
                              </span>
                            );
                          })()}
                        </div>
                      </div>
                      <div className="settings-actions workspace-agent-item-actions">
                        <span className="compact-note">
                          {latestActivity ? `${latestActivityLabel} · ${formatEventTimestamp(latestActivity.ts)}` : "No activity yet"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
        ) : null}
      </section>
    );
  }

  function renderPlannerThread(): JSX.Element {
    const plannerHistoryEntries = [
      ...savedPlannerRecommendations.map((record) => ({
        id: `planner-saved-${record.savedAt}`,
        ts: record.savedAt,
        role: "assistant" as const,
        source: "saved" as const,
        suggestion: record.suggestion,
        task: record.task,
        constraints: record.constraints,
      })),
      ...plannerConversationItems
        .filter((entry): entry is Extract<PlannerThreadEntry, { role: "assistant" }> => entry.role === "assistant")
        .map((entry) => {
          const previousUserEntry = [...plannerConversationItems]
            .slice(0, plannerConversationItems.findIndex((candidate) => candidate.id === entry.id))
            .reverse()
            .find((candidate): candidate is Extract<PlannerThreadEntry, { role: "user" }> => candidate.role === "user");

          return {
            ...entry,
            task: previousUserEntry?.task,
            constraints: previousUserEntry?.constraints,
          };
        }),
    ]
      .reduce<Array<{
        id: string;
        ts: string;
        role: "assistant";
        source: "live" | "saved";
        suggestion: TaskPlanningSuggestion;
        task?: string;
        constraints?: string;
      }>>((entries, entry) => {
        if (entries.some((candidate) => candidate.id === entry.id)) {
          return entries;
        }

        entries.push(entry);
        return entries;
      }, [])
      .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));

    return (
      <section className="thread-surface panel-tone-home">
        <div className="thread-panel-header">
          <div>
            <span className="panel-kicker">Planner session</span>
            <h2>Plan with one conversation</h2>
            <p>Describe the outcome once, tune the advisor here, and turn the recommendation into runnable agents from this same page.</p>
          </div>
          <div className="compact-notices">
            <span className="compact-note">
              {plannerProviderDraft} / {plannerModelDraft.trim() || defaultModelForProvider(plannerProviderDraft)}
            </span>
            <span className="compact-note">
              {plannerSuggestion ? `${plannerSuggestion.recommendedAgentCount} agents suggested` : "No recommendation yet"}
            </span>
          </div>
        </div>

        <section className="thread-section-card">
          <div className="dock-subheader">
            <strong>Planner controls</strong>
            <span className="compact-note">{workspaceData?.workspace.name ?? "No workspace selected"}</span>
          </div>
          <div className="menu-form-grid">
            <label className="settings-field">
              <span>Provider</span>
              <select
                className="workspace-picker"
                value={plannerProviderDraft}
                onChange={(event) => {
                  const nextProvider = event.target.value as "codex" | "claude";
                  setPlannerProviderDraft(nextProvider);
                  setPlannerModelDraft(defaultModelForProvider(nextProvider));
                }}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label className="settings-field">
              <span>Model</span>
              <input
                type="text"
                value={plannerModelDraft}
                onChange={(event) => setPlannerModelDraft(event.target.value)}
                placeholder={defaultModelForProvider(plannerProviderDraft)}
              />
            </label>
          </div>
          <div className="planner-compose-grid">
            <label className="settings-field">
              <span>Planner prompt</span>
              <textarea
                className="settings-textarea settings-textarea-sidebar"
                value={plannerTaskDraft}
                onChange={(event) => setPlannerTaskDraft(event.target.value)}
                placeholder="Describe the work, the desired outcome, and the kind of team shape you want."
                rows={6}
              />
            </label>
            <label className="settings-field">
              <span>Constraints</span>
              <textarea
                className="settings-textarea settings-textarea-sidebar"
                value={plannerConstraintsDraft}
                onChange={(event) => setPlannerConstraintsDraft(event.target.value)}
                placeholder="Budget, time pressure, preferred providers, ownership boundaries..."
                rows={6}
              />
            </label>
          </div>
          <div className="thread-composer-actions">
            <div className="compact-notices">
              {lastSavedPlannerRecommendation ? (
                <span className="compact-note">saved recommendation available</span>
              ) : (
                <span className="compact-note">no saved recommendation yet</span>
              )}
              {plannerSuggestion ? (
                <span className="compact-note">
                  {plannerSuggestion.recommendedAgentCount} agent{plannerSuggestion.recommendedAgentCount === 1 ? "" : "s"} suggested
                </span>
              ) : null}
            </div>
            <div className="settings-actions">
              <button
                className="outline-button"
                disabled={!lastSavedPlannerRecommendation}
                onClick={() => void handleLoadSavedPlannerRecommendation()}
                type="button"
              >
                Load saved
              </button>
              <button
                className="outline-button success-button"
                disabled={!canRequestPlannerSuggestion || plannerSuggestionMutation.isPending}
                onClick={() => void handleRequestPlannerSuggestion()}
                type="button"
              >
                {plannerSuggestionMutation.isPending ? "Planning..." : "Plan"}
              </button>
            </div>
          </div>
        </section>

        {plannerSuggestion ? (
          <section className="thread-section-card planner-recommendation-banner">
            <div className="dock-subheader">
              <div>
                <strong>Recommendation</strong>
                <p className="planner-recommendation-copy">
                  {plannerSuggestion.recommendedAgentCount} recommended agent
                  {plannerSuggestion.recommendedAgentCount === 1 ? "" : "s"} ready to review, save, or launch.
                </p>
              </div>
              <div className="compact-notices">
                <span className="compact-note">
                  advisor {plannerSuggestion.advisorProvider}/{plannerSuggestion.advisorModel}
                </span>
                {lastSavedPlannerRecommendation ? (
                  <span className="compact-note">
                    last saved {formatDateTime(lastSavedPlannerRecommendation.savedAt)}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="thread-message-markdown">{renderMarkdownBlocks(plannerSuggestion.summary)}</div>
            <div className="selection-grid">
              {plannerSuggestion.agents.map((recommendation, index) => (
                <article
                  key={`planner-banner-${recommendation.role}-${index}`}
                  className="selection-card planner-suggestion-card"
                >
                  <div className="planner-suggestion-body">
                    <strong className="planner-suggestion-title">{recommendation.role}</strong>
                    <div className="menu-form-grid planner-agent-grid">
                      <label className="settings-field">
                        <span>Provider</span>
                        <select
                          className="workspace-picker"
                          value={(plannerAgentDrafts[index] ?? recommendation).provider}
                          onChange={(event) =>
                            handlePlannerAgentDraftChange(index, {
                              provider: event.target.value as "codex" | "claude",
                            })
                          }
                        >
                          <option value="codex">Codex</option>
                          <option value="claude">Claude</option>
                        </select>
                      </label>
                      <label className="settings-field">
                        <span>Model</span>
                        <input
                          type="text"
                          value={(plannerAgentDrafts[index] ?? recommendation).model}
                          onChange={(event) =>
                            handlePlannerAgentDraftChange(index, {
                              model: event.target.value,
                            })
                          }
                          placeholder={recommendation.model}
                        />
                      </label>
                    </div>
                    <div className="thread-message-markdown">{renderMarkdownBlocks(recommendation.objective)}</div>
                    <div className="thread-message-markdown thread-message-detail">
                      {renderMarkdownBlocks(recommendation.reasoning)}
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {(plannerSuggestion.coordinationNotes.length > 0 || plannerSuggestion.risks.length > 0) ? (
              <div className="selection-grid planner-recommendation-meta">
                <article className="selection-card">
                  <div>
                    <strong>Coordination</strong>
                    <p>
                      {plannerSuggestion.coordinationNotes.length > 0
                        ? plannerSuggestion.coordinationNotes.join(" ")
                        : "No coordination notes were returned."}
                    </p>
                  </div>
                </article>
                <article className="selection-card">
                  <div>
                    <strong>Risks</strong>
                    <p>
                      {plannerSuggestion.risks.length > 0
                        ? plannerSuggestion.risks.join(" ")
                        : "No explicit risks were returned."}
                    </p>
                  </div>
                </article>
              </div>
            ) : null}
            <div className="settings-actions planner-recommendation-actions">
              <button
                className="outline-button"
                disabled={plannerFleetPending}
                onClick={() => void handleCreateSuggestedFleet(false)}
                type="button"
              >
                {plannerFleetPending ? "Creating..." : "Create fleet"}
              </button>
              <button
                className="outline-button"
                disabled={plannerFleetPending}
                onClick={() => void handleCreateSuggestedFleet(true)}
                type="button"
              >
                {plannerFleetPending ? "Launching..." : "Create + launch"}
              </button>
              <button
                className="outline-button"
                disabled={plannerSavePending || saveSharedContextMutation.isPending}
                onClick={() => void handleSavePlannerRecommendation()}
                type="button"
              >
                {plannerSavePending || saveSharedContextMutation.isPending ? "Saving..." : "Save to history"}
              </button>
            </div>
          </section>
        ) : null}

        {plannerHistoryEntries.length > 0 ? (
          <section className="thread-section-card planner-history-banner">
            <div className="dock-subheader">
              <strong>Recommendation history</strong>
              <span className="compact-note">{plannerHistoryEntries.length} recommendation{plannerHistoryEntries.length === 1 ? "" : "s"}</span>
            </div>
            <div className="planner-history-list">
              {plannerHistoryEntries.map((entry) => {
                const isActive = activePlannerHistoryEntryId === entry.id;

                return (
                  <button
                    key={`planner-history-${entry.id}`}
                    className={isActive ? "planner-history-item planner-history-item-active" : "planner-history-item"}
                    onClick={() => {
                      setPlannerSuggestionState(entry.suggestion);
                      setActivePlannerHistoryEntryId(entry.id);
                      setPlannerProviderDraft(entry.suggestion.advisorProvider);
                      setPlannerModelDraft(entry.suggestion.advisorModel);
                      if (entry.task) {
                        setPlannerTaskDraft(entry.task);
                      }
                      setPlannerConstraintsDraft(entry.constraints ?? "");
                      setPlannerAgentDrafts(
                        entry.suggestion.agents.map((agent) => ({
                          provider: agent.provider,
                          model: agent.model,
                        })),
                      );
                    }}
                    type="button"
                  >
                    <div className="planner-history-item-head">
                      <strong>{entry.source === "saved" ? "Saved recommendation" : "Live recommendation"}</strong>
                      <span>{formatEventTimestamp(entry.ts)}</span>
                    </div>
                    <div className="compact-notices">
                      <span className="compact-note">
                        {entry.suggestion.advisorProvider}/{entry.suggestion.advisorModel}
                      </span>
                      <span className="compact-note">
                        {entry.suggestion.recommendedAgentCount} agent{entry.suggestion.recommendedAgentCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p>{truncateText(entry.suggestion.summary, 180)}</p>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="thread-stream">
          {plannerConversationItems.length > 0 ? (
            plannerConversationItems.map((entry) =>
              entry.role === "user" ? (
                <article key={entry.id} className="thread-message thread-message-user">
                  <div className="event-item-header">
                    <strong>You</strong>
                    <span>{formatEventTimestamp(entry.ts)}</span>
                  </div>
                  <div className="thread-message-markdown">{renderMarkdownBlocks(entry.task)}</div>
                  <div className="compact-notices">
                    <span className="compact-note">
                      advisor {entry.provider}/{entry.model}
                    </span>
                    {entry.constraints ? <span className="compact-note">{truncateText(entry.constraints, 120)}</span> : null}
                  </div>
                </article>
              ) : (
                <article key={entry.id} className="thread-message thread-message-assistant">
                  <div className="event-item-header">
                    <strong>{entry.source === "saved" ? "Saved recommendation" : "Planner"}</strong>
                    <span>{formatEventTimestamp(entry.ts)}</span>
                  </div>
                  <div className="thread-message-markdown">{renderMarkdownBlocks(entry.suggestion.summary)}</div>
                  <div className="compact-notices">
                    <span className="compact-note">
                      {entry.suggestion.advisorProvider}/{entry.suggestion.advisorModel}
                    </span>
                    <span className="compact-note">
                      {entry.suggestion.recommendedAgentCount} agent{entry.suggestion.recommendedAgentCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="planner-thread-grid">
                    {entry.suggestion.agents.map((recommendation, index) => {
                      const draft = plannerAgentDrafts[index] ?? recommendation;
                      return (
                        <article key={`${entry.id}-${recommendation.role}-${index}`} className="planner-thread-card">
                          <div className="planner-thread-card-head">
                            <strong>{recommendation.role}</strong>
                            <span className="compact-note">
                              {draft.provider}/{draft.model}
                            </span>
                          </div>
                          <div className="thread-message-markdown">{renderMarkdownBlocks(recommendation.objective)}</div>
                          <div className="thread-message-markdown thread-message-detail">
                            {renderMarkdownBlocks(recommendation.reasoning)}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  {entry.suggestion.coordinationNotes.length > 0 ? (
                    <p className="thread-message-detail">
                      Coordination: {entry.suggestion.coordinationNotes.join(" ")}
                    </p>
                  ) : null}
                  {entry.suggestion.risks.length > 0 ? (
                    <p className="thread-message-detail">
                      Risks: {entry.suggestion.risks.join(" ")}
                    </p>
                  ) : null}
                </article>
              ),
            )
          ) : (
            <div className="panel-empty">
              Start a planner conversation here. Provider, model, constraints, and fleet actions now stay in this thread so the workflow stays in one place.
            </div>
          )}
        </div>
      </section>
    );
  }

  function renderAgentThread(): JSX.Element {
    if (!selectedAgent) {
      return (
        <section className="thread-surface panel-tone-inspector">
          <div className="thread-panel-header">
            <div>
              <span className="panel-kicker">Agents</span>
              <h2>Choose an agent</h2>
              <p>Open a dedicated agent conversation here without leaving the workspace shell.</p>
            </div>
          </div>
          {agents.length > 0 ? (
            <div className="thread-stream">
              {agents.map((agent) => (
                <button
                  key={`agent-choice-${agent.id}`}
                  className="thread-message thread-message-activity thread-message-info"
                  onClick={() => selectAgentThread(agent.id)}
                  type="button"
                >
                  <div className="event-item-header">
                    <strong>{agent.title}</strong>
                    <span>{agent.provider} / {agent.model}</span>
                  </div>
                  <p>{truncateText(getAgentDescription(agent), 220)}</p>
                </button>
              ))}
            </div>
          ) : (
            <div className="panel-empty">Create an agent from the workspace panel first, then open it here.</div>
          )}
        </section>
      );
    }

    const activityCollapsed = Boolean(collapsedAgentActivityById[selectedAgent.id]);

    return (
      <section className="thread-surface panel-tone-inspector">
        <div className="thread-panel-header">
          <div>
            <span className="panel-kicker">Agents</span>
            <h2>{selectedAgent.title}</h2>
            <p>
              {selectedRun
                ? `Focused on ${selectedRun.title}. Transcript, tool activity, approvals, and follow-ups stay together here.`
                : "Start a tracked run and this thread becomes the full conversation, tool loop, and approval stream for the agent."}
            </p>
          </div>
          <div className="compact-notices">
            <label className="settings-field compact-select-field">
              <span>Agent</span>
              <select
                className="workspace-picker"
                value={selectedAgent.id}
                onChange={(event) => selectAgentThread(event.target.value)}
              >
                {agents.map((agent) => (
                  <option key={`agent-thread-switch-${agent.id}`} value={agent.id}>
                    {agent.title}
                  </option>
                ))}
              </select>
            </label>
            <span className="compact-note">
              {selectedAgent.provider} / {selectedAgent.model}
            </span>
            {selectedRun ? <span className="compact-note">run {selectedRun.id}</span> : null}
            {selectedRun ? (() => {
              const contextWindow = getModelContextWindow(selectedAgent.model);
              const usedTokens = selectedAgent.usage.totalInputTokens;
              const pct = Math.min(100, Math.round((usedTokens / contextWindow) * 100));
              return (
                <span className="context-budget-indicator" title={`${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`}>
                  Context: {pct}%
                </span>
              );
            })() : null}
            <span className={`badge badge-${agentStateMeta[selectedAgent.state].tone}`}>
              {agentStateMeta[selectedAgent.state].label}
            </span>
            {!rightSidebarVisible ? (
              <>
                <button
                  className="chip"
                  onClick={() => {
                    setRightSidebarTab("files");
                    setRightSidebarVisible(true);
                  }}
                  type="button"
                >
                  Files
                </button>
                <button
                  className="chip"
                  onClick={() => {
                    setRightSidebarTab("terminal");
                    setRightSidebarVisible(true);
                  }}
                  type="button"
                >
                  Terminal
                </button>
                <button
                  className="chip"
                  onClick={() => {
                    setRightSidebarTab("details");
                    setRightSidebarVisible(true);
                  }}
                  type="button"
                >
                  Agent
                </button>
              </>
            ) : null}
          </div>
        </div>

        <section className="thread-section-card">
          <div className="dock-subheader">
            <strong>Recent activity</strong>
            <div className="settings-actions">
              <span className="compact-note">
                {selectedAgentActivityFeed.length} event{selectedAgentActivityFeed.length === 1 ? "" : "s"}
              </span>
              <button
                className="outline-button outline-button-small"
                onClick={() =>
                  setCollapsedAgentActivityById((current) => ({
                    ...current,
                    [selectedAgent.id]: !current[selectedAgent.id],
                  }))
                }
                type="button"
              >
                {activityCollapsed ? "Expand" : "Collapse"}
              </button>
            </div>
          </div>
          {!activityCollapsed && selectedAgentActivityFeed.length > 0 ? (
            <div className="activity-list activity-list-inline">
              {selectedAgentActivityFeed.map((item) => (
                <button
                  key={`agent-live-${item.id}`}
                  className={`activity-item activity-item-${item.tone}`}
                  onClick={() => focusFleetActivityItem(item)}
                  type="button"
                >
                  <div className="activity-item-header">
                    <strong title={item.agentTitle}>{item.agentTitle}</strong>
                    <span>{formatEventTimestamp(item.ts)}</span>
                  </div>
                  <div className="activity-item-summary">{item.summary}</div>
                  {item.detail ? <p className="activity-item-detail">{item.detail}</p> : null}
                </button>
              ))}
            </div>
          ) : activityCollapsed ? (
            <div className="panel-empty">Recent activity is collapsed. Expand it to inspect live agent events.</div>
          ) : (
            <div className="panel-empty">No live activity yet for this agent. Start a run or send a focused message to populate the stream.</div>
          )}
        </section>

        <div className="thread-stream">
          {selectedRunApprovals.map((approval) => (
            <article key={approval.id} className="thread-message thread-message-warning">
              <div className="event-item-header">
                <strong>{approval.requestedAction}</strong>
                <span>{formatDateTime(approval.createdAt)}</span>
              </div>
              <p>{approval.reason || "The agent requested approval for a risky action."}</p>
              <div className="compact-notices">
                <span className="compact-note">{runToolCallById.get(approval.toolCallId)?.status ?? "pending"}</span>
                {runToolCallById.get(approval.toolCallId)?.requestedCwd ? (
                  <span className="compact-note">{runToolCallById.get(approval.toolCallId)?.requestedCwd}</span>
                ) : null}
              </div>
              <pre className="file-preview-code">{formatJsonPreview(approval.requestedPayload)}</pre>
              <div className="settings-actions">
                <button className="outline-button success-button" onClick={() => void handleApprove(approval.id)} type="button">
                  Approve
                </button>
                <button className="outline-button danger-button" onClick={() => void handleDeny(approval.id)} type="button">
                  Deny
                </button>
              </div>
            </article>
          ))}

          {selectedRun ? (
            selectedRunThreadTimeline.length > 0 ? (
              selectedRunThreadTimeline.map((item) => {
                if (item.kind === "conversation") {
                  const toneClass =
                    item.entry.entryType === "user"
                      ? "thread-message-user"
                      : item.entry.entryType === "assistant"
                        ? "thread-message-assistant"
                        : item.entry.entryType === "error"
                          ? "thread-message-danger"
                          : "thread-message-muted";

                  return (
                    <article key={item.id} className={`thread-message ${toneClass}`}>
                      <div className="event-item-header">
                        <strong>{item.entry.entryType}</strong>
                        <span>{formatEventTimestamp(item.entry.createdAt)}</span>
                      </div>
                      <div className="thread-message-markdown">{renderMarkdownBlocks(item.entry.content)}</div>
                      {Object.keys(item.entry.metadata).length > 0 ? (
                        <pre className="file-preview-code">{formatJsonPreview(item.entry.metadata)}</pre>
                      ) : null}
                    </article>
                  );
                }

                if (item.kind === "toolCall") {
                  return (
                    <article key={item.id} className="thread-message thread-message-info">
                      <div className="event-item-header">
                        <strong>tool · {item.toolCall.toolName}</strong>
                        <span>{formatEventTimestamp(item.toolCall.updatedAt)}</span>
                      </div>
                      <div className="compact-notices">
                        <span className="compact-note">{item.toolCall.status}</span>
                        {item.toolCall.requestedCwd ? <span className="compact-note">{item.toolCall.requestedCwd}</span> : null}
                        {item.toolCall.approvalId ? <span className="compact-note">approval {item.toolCall.approvalId}</span> : null}
                      </div>
                      <pre className="file-preview-code">{formatJsonPreview(item.toolCall.input)}</pre>
                      {item.toolCall.output ? (
                        <pre className="file-preview-code">{formatJsonPreview(item.toolCall.output)}</pre>
                      ) : null}
                    </article>
                  );
                }

                if (item.kind === "artifact") {
                  return (
                    renderArtifactInlineCard(
                      item.id,
                      item.artifact,
                      <button
                        className="outline-button"
                        onClick={() => {
                          setRightSidebarTab("files");
                          setRightSidebarVisible(true);
                        }}
                        type="button"
                      >
                        Open files
                      </button>,
                    )
                  );
                }

                return (
                  <article
                    key={item.id}
                    className={`thread-message ${
                      item.entry.entryType === "approval" ? "thread-message-warning" : "thread-message-info"
                    }`}
                  >
                    <div className="event-item-header">
                      <strong>{item.entry.entryType === "approval" ? "approval event" : "tool activity"}</strong>
                      <span>{formatEventTimestamp(item.entry.createdAt)}</span>
                    </div>
                    <div className="thread-message-markdown">{renderMarkdownBlocks(item.entry.content)}</div>
                    {Object.keys(item.entry.metadata).length > 0 ? (
                      <pre className="file-preview-code">{formatJsonPreview(item.entry.metadata)}</pre>
                    ) : null}
                  </article>
                );
              })
            ) : (
              <div className="panel-empty">No transcript entries yet for this run. Once the agent starts working, the thread will populate here.</div>
            )
          ) : (
            <div className="panel-empty">No run selected yet. Start a tracked run from the composer below.</div>
          )}

          {selectedRunHandoffs.map((handoff) => (
            <article key={handoff.id} className="thread-message thread-message-info">
              <div className="event-item-header">
                <strong>{handoff.title}</strong>
                <span>{handoff.status.toLowerCase()}</span>
              </div>
              <div className="thread-message-markdown">{renderMarkdownBlocks(handoff.summary)}</div>
              <div className="compact-notices">
                <span className="compact-note">
                  {handoff.recommendedProvider}/{handoff.recommendedModel}
                </span>
                <span className="compact-note">{handoff.artifactIds.length} artifacts</span>
              </div>
              <div className="thread-message-markdown thread-message-detail">
                {renderMarkdownBlocks(truncateText(handoff.nextPrompt, 220))}
              </div>
              <div className="settings-actions">
                <button className="outline-button" onClick={() => void handleCreateAgentFromInbox(handoff.id)} type="button">
                  Create follow-up
                </button>
                <button className="outline-button" onClick={() => selectHomeThread({ kind: "inbox" })} type="button">
                  Open inbox
                </button>
              </div>
            </article>
          ))}
        </div>

        <div className="thread-composer-shell">
          <label className="settings-field">
            <span>Message to agent</span>
            <textarea
              className="settings-textarea broadcast-textarea"
              value={agentInputDraft}
              onChange={(event) => setAgentInputDraft(event.target.value)}
              placeholder="Ask this agent to investigate, implement, review, or continue from the latest run."
              rows={3}
            />
          </label>
          <div className="thread-composer-actions">
            <div className="compact-notices">
              <span className="compact-note">
                {selectedRun ? `${runToolCalls.length} tool steps` : "No run started"}
              </span>
              <span className="compact-note">{selectedRunApprovals.length} approvals</span>
              <span className="compact-note">{runArtifacts.length} artifacts</span>
            </div>
            <button
              className="outline-button success-button"
              disabled={!canSendAgentInput || agentMessagePending}
              onClick={() => void handleSendToSelectedAgent()}
              type="button"
            >
              {agentMessagePending ? "Starting..." : "Start run"}
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderHomeThreadContent(): JSX.Element {
    switch (homeThread.kind) {
      case "workspace":
        return renderWorkspaceThread();
      case "planner":
        return renderPlannerThread();
      case "inbox":
        return renderInboxThread();
      case "agent":
        return renderAgentThread();
      default:
        return renderWorkspaceThread();
    }
  }

  function renderInspectorContent(): JSX.Element {
    if (!selectedAgent) {
      return <p className="inspector-empty">Select an agent tile to inspect output and events.</p>;
    }

    if (inspectorTab === "session") {
      return (
        <div className="inspector-section conversation-panel">
          <div className="agent-output-hero">
            <span className="panel-kicker">Latest run</span>
            <p>
              {selectedRun
                ? `${selectedRun.title} · ${selectedRun.state.toLowerCase()}`
                : "Start a tracked run to see transcript, tool calls, approvals, and artifacts here."}
            </p>
          </div>
          {selectedRun ? (
            <div className="compact-notices">
              <span className="compact-note">run {selectedRun.id}</span>
              <span className="compact-note">{selectedRun.prompt.slice(0, 72)}</span>
              <span className="compact-note">{runToolCalls.length} tool steps</span>
              <span className="compact-note">{runArtifacts.length} artifacts</span>
            </div>
          ) : null}

          {selectedRunApprovals.length > 0 ? (
            <div className="agent-output-hero run-section run-section-risk">
              <span className="panel-kicker">Pending approvals</span>
              <div className="run-card-grid">
                {selectedRunApprovals.map((approval) => (
                  <article key={approval.id} className="run-card run-card-approval">
                    <div className="event-item-header">
                      <strong>{approval.requestedAction}</strong>
                      <span>{formatDateTime(approval.createdAt)}</span>
                    </div>
                    <p>{approval.reason || "The model did not include a separate rationale for this request."}</p>
                    <div className="compact-notices">
                      <span className="compact-note">
                        status {runToolCallById.get(approval.toolCallId)?.status ?? "pending"}
                      </span>
                      {runToolCallById.get(approval.toolCallId)?.requestedCwd ? (
                        <span className="compact-note">{runToolCallById.get(approval.toolCallId)?.requestedCwd}</span>
                      ) : null}
                    </div>
                    <pre className="file-preview-code">{formatJsonPreview(approval.requestedPayload)}</pre>
                    <div className="settings-actions">
                      <button className="outline-button success-button" onClick={() => void handleApprove(approval.id)} type="button">
                        Approve
                      </button>
                      <button className="outline-button danger-button" onClick={() => void handleDeny(approval.id)} type="button">
                        Deny
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {selectedRun ? (
            <div className="run-summary-grid">
              <article className="run-card">
                <span className="panel-kicker">Diffs</span>
                <strong>{selectedRunPatchArtifacts.length}</strong>
                <p>{latestRunPatchArtifact ? latestRunPatchArtifact.uri : "No patch artifact captured yet."}</p>
                <button
                  className="outline-button"
                  onClick={() => {
                    setRightSidebarTab("artifacts");
                    setRightSidebarVisible(true);
                  }}
                  type="button"
                >
                  Show diffs and artifacts
                </button>
              </article>
              <article className="run-card">
                <span className="panel-kicker">Logs</span>
                <strong>{selectedRunLogArtifacts.length}</strong>
                <p>
                  {selectedRunLogArtifacts[0]
                    ? truncateText(selectedRunLogArtifacts[0].uri, 120)
                    : "No log artifact captured yet."}
                </p>
                <button
                  className="outline-button"
                  onClick={() => {
                    setRightSidebarTab("artifacts");
                    setRightSidebarVisible(true);
                  }}
                  type="button"
                >
                  Open logs
                </button>
              </article>
              <article className="run-card">
                <span className="panel-kicker">Follow-ups</span>
                <strong>{selectedRunHandoffs.length}</strong>
                <p>
                  {selectedRunHandoffs[0]
                    ? truncateText(selectedRunHandoffs[0].title, 120)
                    : "No handoff items were created from this run yet."}
                </p>
                <button className="outline-button" onClick={() => selectHomeThread({ kind: "inbox" })} type="button">
                  Open inbox follow-ups
                </button>
              </article>
            </div>
          ) : null}

          {selectedRunHandoffs.length > 0 ? (
            <div className="agent-output-hero run-section">
              <span className="panel-kicker">Inbox follow-ups</span>
              <div className="run-card-grid">
                {selectedRunHandoffs.map((handoff) => (
                  <article key={handoff.id} className="run-card">
                    <div className="event-item-header">
                      <strong>{handoff.title}</strong>
                      <span>{handoff.status.toLowerCase()}</span>
                    </div>
                    <p>{handoff.summary}</p>
                    <div className="compact-notices">
                      <span className="compact-note">
                        {handoff.recommendedProvider}/{handoff.recommendedModel}
                      </span>
                      <span className="compact-note">{handoff.artifactIds.length} artifacts</span>
                    </div>
                    <pre className="file-preview-code">{handoff.nextPrompt}</pre>
                    <div className="settings-actions">
                      <button className="outline-button" onClick={() => void handleCreateAgentFromInbox(handoff.id)} type="button">
                        Create follow-up
                      </button>
                      {selectedAgent ? (
                        <button className="outline-button" onClick={() => void handleAssignInbox(handoff.id, selectedAgent.id)} type="button">
                          Assign to {selectedAgent.title}
                        </button>
                      ) : null}
                      <button className="outline-button" onClick={() => selectHomeThread({ kind: "inbox" })} type="button">
                        Open inbox
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {runToolCalls.length > 0 ? (
            <div className="agent-output-hero run-section">
              <span className="panel-kicker">Tool loop</span>
              <div className="run-card-grid">
                {runToolCalls
                  .slice()
                  .reverse()
                  .map((toolCall) => (
                    <article key={toolCall.id} className="run-card">
                      <div className="event-item-header">
                        <strong>{toolCall.toolName}</strong>
                        <span>{toolCall.status}</span>
                      </div>
                      <div className="compact-notices">
                        {toolCall.requestedCwd ? <span className="compact-note">{toolCall.requestedCwd}</span> : null}
                        {toolCall.approvalId ? <span className="compact-note">approval {toolCall.approvalId}</span> : null}
                      </div>
                      <pre className="file-preview-code">{formatJsonPreview(toolCall.input)}</pre>
                      {toolCall.output ? (
                        <pre className="file-preview-code">{formatJsonPreview(toolCall.output)}</pre>
                      ) : null}
                    </article>
                  ))}
              </div>
            </div>
          ) : null}

          {selectedRunTelemetryEvents.length > 0 ? (
            <div className="agent-output-hero run-section">
              <span className="panel-kicker">Live telemetry</span>
              <div className="compact-notices">
                <span className="compact-note">{selectedRunTelemetryEvents.length} events</span>
                <span className="compact-note">{selectedRunTelemetrySummary.outputDeltas} deltas</span>
                <span className="compact-note">{selectedRunTelemetrySummary.toolSteps} tool events</span>
                <span className="compact-note">{selectedRunTelemetrySummary.usageTicks} usage ticks</span>
                <span className="compact-note">{selectedRunTelemetrySummary.heartbeats} heartbeats</span>
                <span className="compact-note">{selectedRunTelemetrySummary.errors} errors</span>
              </div>
              {selectedRunLatestUsageEvent ? (
                <div className="compact-notices">
                  <span className="compact-note">
                    latest usage {summarizeEvent(selectedRunLatestUsageEvent)}
                  </span>
                </div>
              ) : null}
              {selectedRunLiveText ? <pre className="file-preview-code">{selectedRunLiveText}</pre> : null}
              <ul className="session-list session-list-compact">
                {selectedRunTelemetryEvents
                  .slice()
                  .reverse()
                  .slice(0, 12)
                  .map((event) => {
                    const preview = getEventPayloadPreview(event);

                    return (
                      <li key={event.eventId} className={`session-item session-${getTranscriptTone(event)}`}>
                        <div className="event-item-header">
                          <strong>{event.type.toLowerCase()}</strong>
                          <span>{formatEventTimestamp(event.ts)}</span>
                        </div>
                        <p>{summarizeEvent(event)}</p>
                        {preview && preview !== summarizeEvent(event) ? (
                          <pre className="file-preview-code">{preview}</pre>
                        ) : null}
                      </li>
                    );
                  })}
              </ul>
            </div>
          ) : null}

          {selectedRunActivity.length > 0 ? (
            <div className="agent-output-hero run-section">
              <span className="panel-kicker">Run activity</span>
              <ul className="session-list session-list-compact">
                {selectedRunActivity
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <li key={entry.id} className={`session-item session-${entry.entryType === "approval" ? "tool" : "system"}`}>
                      <div className="event-item-header">
                        <strong>{entry.entryType}</strong>
                        <span>{formatEventTimestamp(entry.createdAt)}</span>
                      </div>
                      <p>{entry.content}</p>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          {selectedRunTranscriptQuery.isLoading ? (
            <p className="inspector-empty">Loading run transcript...</p>
          ) : selectedRunConversation.length > 0 ? (
            <div className="agent-output-hero run-section">
              <span className="panel-kicker">Conversation</span>
              <ul className="session-list">
                {selectedRunConversation
                  .slice()
                  .reverse()
                  .map((entry: TranscriptEntryRecord) => {
                    const tone =
                      entry.entryType === "error"
                        ? "error"
                        : entry.entryType === "assistant"
                          ? "assistant"
                          : "system";

                    return (
                      <li key={entry.id} className={`session-item session-${tone}`}>
                        <div className="event-item-header">
                          <strong>{entry.entryType}</strong>
                          <span>{formatEventTimestamp(entry.createdAt)}</span>
                        </div>
                        <p>{entry.content}</p>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ) : (
            <p className="inspector-empty">No run transcript yet. Start a run from the agent composer.</p>
          )}
        </div>
      );
    }

    if (inspectorTab === "ops") {
      return (
        <div className="inspector-section">
          <div className="settings-actions inspector-actions">
            <button
              className="outline-button"
              disabled={startSelectedAgentMutation.isPending}
              onClick={() => void handleStartSelectedAgent()}
              type="button"
            >
              {startSelectedAgentMutation.isPending ? "Starting..." : "Start"}
            </button>
            <button
              className="outline-button"
              disabled={interruptSelectedAgentMutation.isPending || selectedAgent.state !== "RUNNING"}
              onClick={() => void handleInterruptSelectedAgent()}
              type="button"
            >
              {interruptSelectedAgentMutation.isPending ? "Interrupting..." : "Interrupt"}
            </button>
            <button
              className="outline-button danger-button"
              disabled={
                stopSelectedAgentMutation.isPending ||
                selectedAgent.state === "STOPPED" ||
                selectedAgent.state === "COMPLETED"
              }
              onClick={() => void handleStopSelectedAgent()}
              type="button"
            >
              {stopSelectedAgentMutation.isPending ? "Stopping..." : "Stop"}
            </button>
            <button
              className="outline-button"
              disabled={!selectedRun || stopRunMutation.isPending}
              onClick={() => void handleStopSelectedRun()}
              type="button"
            >
              {stopRunMutation.isPending ? "Stopping run..." : "Stop run"}
            </button>
            <button
              className="outline-button"
              disabled={!selectedAgent.worktree || resetWorktreeMutation.isPending}
              onClick={() => void handleResetSelectedWorktree()}
              type="button"
            >
              {resetWorktreeMutation.isPending ? "Resetting..." : "Reset worktree"}
            </button>
          </div>

          <div className="selection-grid">
            <article className="selection-card">
              <div>
                <strong>Total events</strong>
                <p>{selectedAgentEventStats.counts.total}</p>
              </div>
            </article>
            <article className="selection-card">
              <div>
                <strong>Outputs</strong>
                <p>{selectedAgentEventStats.counts.outputs}</p>
              </div>
            </article>
            <article className="selection-card">
              <div>
                <strong>Errors</strong>
                <p>{selectedAgentEventStats.counts.errors}</p>
              </div>
            </article>
            <article className="selection-card">
              <div>
                <strong>Tool calls</strong>
                <p>{selectedAgentEventStats.counts.toolCalls}</p>
              </div>
            </article>
            <article className="selection-card">
              <div>
                <strong>Usage ticks</strong>
                <p>{selectedAgentEventStats.counts.usageTicks}</p>
              </div>
            </article>
            <article className="selection-card">
              <div>
                <strong>Heartbeats</strong>
                <p>{selectedAgentEventStats.counts.heartbeats}</p>
              </div>
            </article>
          </div>

          <dl className="meta-list">
            <div>
              <dt>Active run</dt>
              <dd>{selectedRun ? selectedRun.title : "No tracked run yet"}</dd>
            </div>
            <div>
              <dt>Last event</dt>
              <dd>{formatDateTime(selectedAgent.lastEventAt)}</dd>
            </div>
            <div>
              <dt>Last heartbeat</dt>
              <dd>{formatDateTime(selectedAgent.heartbeatAt)}</dd>
            </div>
            <div>
              <dt>Input tokens</dt>
              <dd>{selectedAgent.usage.totalInputTokens.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{selectedAgent.usage.totalOutputTokens.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Total cost</dt>
              <dd>{usageFormatters.cost(selectedAgent.usage.totalCostUsd)}</dd>
            </div>
            <div>
              <dt>Runtime session</dt>
              <dd>
                {typeof selectedAgent.metadata.runtimeSessionId === "string"
                  ? selectedAgent.metadata.runtimeSessionId
                  : "Not started yet"}
              </dd>
            </div>
            <div>
              <dt>Worktree</dt>
              <dd>{selectedAgent.worktree?.path ?? "No agent worktree yet"}</dd>
            </div>
          </dl>

          {selectedAgentEventStats.latestError ? (
            <div className="agent-output-hero">
              <span className="panel-kicker">Latest error</span>
              <p>{summarizeEvent(selectedAgentEventStats.latestError)}</p>
            </div>
          ) : null}

          {selectedRun ? (
            <div className="run-summary-grid">
              <article className="run-card">
                <span className="panel-kicker">Pending approvals</span>
                <strong>{selectedRunApprovals.length}</strong>
                <p>Approve or deny risky commands from the selected run.</p>
                <button className="outline-button" onClick={() => selectHomeThread({ kind: "inbox" })} type="button">
                  Review approvals
                </button>
              </article>
              <article className="run-card">
                <span className="panel-kicker">Latest diff</span>
                <strong>{selectedRunPatchArtifacts.length}</strong>
                <p>{latestRunPatchArtifact ? truncateText(latestRunPatchArtifact.uri, 120) : "No patch artifact yet."}</p>
                <button
                  className="outline-button"
                  onClick={() => {
                    setRightSidebarTab("artifacts");
                    setRightSidebarVisible(true);
                  }}
                  type="button"
                >
                  Show artifacts
                </button>
              </article>
              <article className="run-card">
                <span className="panel-kicker">Inbox follow-ups</span>
                <strong>{selectedRunHandoffs.length}</strong>
                <p>{selectedRunHandoffs[0] ? truncateText(selectedRunHandoffs[0].title, 120) : "No follow-up handoff yet."}</p>
                <button className="outline-button" onClick={() => selectHomeThread({ kind: "inbox" })} type="button">
                  Open inbox
                </button>
              </article>
            </div>
          ) : null}

          {selectedAgentEventStats.latestToolCall ? (
            <div className="agent-output-hero">
              <span className="panel-kicker">Latest tool activity</span>
              <p>
                {runToolCalls[0]
                  ? `${runToolCalls[0].toolName} · ${runToolCalls[0].status}`
                  : summarizeEvent(selectedAgentEventStats.latestToolCall)}
              </p>
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="inspector-section">
        <label className="settings-field">
          <span>Agent title</span>
          <input
            type="text"
            value={agentTitleDraft}
            onChange={(event) => setAgentTitleDraft(event.target.value)}
            placeholder="Agent title"
          />
        </label>
        <label className="settings-field">
          <span>Working directory</span>
          <input
            type="text"
            value={agentWorkingDirectoryDraft}
            onChange={(event) => setAgentWorkingDirectoryDraft(event.target.value)}
            placeholder={workspaceData?.workspace.projectRoot || "Use workspace project root"}
          />
        </label>
        <p className="compact-note">Leave blank to use the workspace project root. Custom paths must stay inside that root.</p>
        <div className="settings-actions">
          <button
            className="outline-button"
            disabled={!canRenameAgent || renameAgentMutation.isPending}
            onClick={() => void handleRenameAgent()}
            type="button"
          >
            {renameAgentMutation.isPending ? "Saving..." : "Save settings"}
          </button>
          <button
            className="outline-button"
            disabled={renameAgentMutation.isPending || agentWorkingDirectoryDraft.trim().length === 0}
            onClick={() => setAgentWorkingDirectoryDraft("")}
            type="button"
          >
            Use workspace root
          </button>
        </div>
        <dl className="meta-list">
          <div>
            <dt>Provider</dt>
            <dd>{selectedAgent.provider}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{selectedAgent.model}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{agentStateMeta[selectedAgent.state].label}</dd>
          </div>
          <div>
            <dt>Monitor</dt>
            <dd>{getAgentMonitor(selectedAgent)}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{typeof selectedAgent.metadata.role === "string" ? selectedAgent.metadata.role : "Unspecified"}</dd>
          </div>
          <div>
            <dt>Working directory</dt>
            <dd>{selectedAgent.worktree?.path ?? (typeof selectedAgent.metadata.cwd === "string" ? selectedAgent.metadata.cwd : "Workspace default")}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>{usageFormatters.cost(selectedAgent.usage.totalCostUsd)}</dd>
          </div>
          <div>
            <dt>Last event</dt>
            <dd>{formatEventTimestamp(selectedAgent.lastEventAt)}</dd>
          </div>
        </dl>
      </div>
    );
  }

  function renderExplorerEntry(node: FileTreeNodeRecord): JSX.Element {
    const isFile = node.kind === "file";
    const isSelected = isFile && selectedExplorerFilePath === node.path;
    const relativePath = getRelativePath(explorerBoundaryRoot || explorerDisplayRoot || "/", node.path);
    const childCount = node.children?.length ?? 0;
    const secondaryLabel = node.truncated
      ? "More results available"
      : isFile
        ? relativePath
        : childCount > 0
          ? `${childCount} item${childCount === 1 ? "" : "s"}`
          : "Empty folder";

    return (
      <div key={node.path} className="explorer-entry-wrap">
        <button
          className={isSelected ? "explorer-entry explorer-entry-active" : "explorer-entry"}
          onClick={() => {
            if (node.truncated) {
              return;
            }

            if (isFile) {
              openExplorerFile(node.path);
              return;
            }

            navigateExplorer(node.path);
          }}
          type="button"
        >
          <span className={`explorer-entry-icon explorer-entry-icon-${node.kind}`}>
            {node.truncated ? "…" : isFile ? "F" : "D"}
          </span>
          <span className="explorer-entry-body">
            <strong>{node.name}</strong>
            <span>{secondaryLabel}</span>
          </span>
        </button>
      </div>
    );
  }

  function renderExplorerTreeNode(node: FileTreeNodeRecord, depth = 0): JSX.Element {
    const isDirectory = node.kind === "directory";
    const isSelected = !isDirectory && selectedExplorerFilePath === node.path;
    const isExpanded = isDirectory && expandedExplorerPaths.includes(node.path);

    return (
      <div key={node.path} className="explorer-tree-node">
        <button
          className={isSelected ? "explorer-entry explorer-entry-active" : "explorer-entry"}
          onClick={() => {
            if (node.truncated) {
              return;
            }

            if (isDirectory) {
              toggleExplorerExpanded(node.path);
              return;
            }

            openExplorerFile(node.path);
          }}
          style={{ paddingLeft: `${depth * 14 + 12}px` }}
          type="button"
        >
          <span className="explorer-entry-caret">{isDirectory ? (isExpanded ? "▾" : "▸") : ""}</span>
          <span className={`explorer-entry-icon explorer-entry-icon-${node.kind}`}>
            {node.truncated ? "…" : isDirectory ? "D" : "F"}
          </span>
          <span className="explorer-entry-body explorer-entry-body-compact">
            <strong>{node.name}</strong>
          </span>
        </button>
        {isDirectory && isExpanded && node.children && node.children.length > 0 ? (
          <div className="explorer-entry-children">
            {node.children.map((child) => renderExplorerTreeNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderCommandPalette(): JSX.Element | null {
    if (!commandPaletteOpen) {
      return null;
    }

    return (
      <div
        className="command-palette-overlay"
        onClick={() => setCommandPaletteOpen(false)}
        role="presentation"
      >
        <div className="command-palette" onClick={(event) => event.stopPropagation()} role="dialog">
          <input
            ref={commandPaletteInputRef}
            className="command-palette-input"
            type="text"
            value={commandPaletteQuery}
            onChange={(event) => setCommandPaletteQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && filteredCommandPaletteActions[0]) {
                event.preventDefault();
                void handleRunPaletteAction(filteredCommandPaletteActions[0]);
              }
            }}
            placeholder="Jump to views, agents, planner, panels, and workspace actions..."
          />
          <div className="command-palette-list">
            {filteredCommandPaletteActions.length > 0 ? (
              filteredCommandPaletteActions.map((action) => (
                <button
                  key={action.id}
                  className="command-palette-item"
                  onClick={() => void handleRunPaletteAction(action)}
                  type="button"
                >
                  <strong>{action.label}</strong>
                  {action.hint ? <span>{action.hint}</span> : null}
                </button>
              ))
            ) : (
              <p className="panel-empty">No commands match the current query.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="shell ide-shell">
      <div
        className="ide-frame"
        style={{ gridTemplateColumns: `${leftRailWidth}px 8px minmax(0, 1fr)` }}
      >
        <aside className="ide-sidebar">
          <div className="brand-block brand-block-sidebar">
            <span className="brand-kicker">ACC</span>
            <strong>Agent Command Center</strong>
          </div>

          <nav className="sidebar-nav">
            <button
              className={activeMenu === null && homeThread.kind === "workspace" ? "menu-button menu-button-active" : "menu-button"}
              onClick={() => selectHomeThread({ kind: "workspace" })}
              type="button"
            >
              Workspace
            </button>
            <button
              className={activeMenu === null && homeThread.kind === "planner" ? "menu-button menu-button-active" : "menu-button"}
              onClick={() => selectHomeThread({ kind: "planner" })}
              type="button"
            >
              Planner
            </button>
            <button
              className={activeMenu === null && homeThread.kind === "inbox" ? "menu-button menu-button-active" : "menu-button"}
              onClick={() => selectHomeThread({ kind: "inbox" })}
              type="button"
            >
              Inbox
            </button>
            <button
              className={activeMenu === "settings" ? "menu-button menu-button-active" : "menu-button"}
              onClick={() => {
                setSettingsDrawerTab("providers");
                setActiveMenu((current) => (current === "settings" ? null : "settings"));
              }}
              type="button"
            >
              Settings
            </button>
          </nav>

          <div className="sidebar-footer">
            <div className="sidebar-footer-row">
              <span className="panel-kicker">Workspace</span>
              <strong className="sidebar-footer-title">{workspaceData?.workspace.name ?? "No workspace"}</strong>
            </div>
            <div className="compact-notices sidebar-footer-pills">
              <span className={healthQuery.data?.ok ? "settings-pill settings-pill-active" : "settings-pill"}>
                {healthQuery.data?.ok ? "connected" : "offline"}
              </span>
              <span className={streamConnected ? "settings-pill settings-pill-active" : "settings-pill"}>
                {streamConnected ? "stream live" : "polling"}
              </span>
            </div>
            {activeMenu === null && homeThread.kind === "workspace" ? (
              <div className="sidebar-workspace-ops">
                {workspaceFocusedAgent ? (
                  <>
                    <div className="compact-notices sidebar-footer-pills">
                      <span className={`badge badge-${agentStateMeta[workspaceFocusedAgent.state].tone}`}>
                        {agentStateMeta[workspaceFocusedAgent.state].label}
                      </span>
                      <span className="compact-note" title={workspaceFocusedAgent.title}>
                        {workspaceFocusedAgent.title}
                      </span>
                    </div>
                    <div className="sidebar-workspace-ops-actions">
                      <button
                        className="outline-button outline-button-small"
                        disabled={startSelectedAgentMutation.isPending}
                        onClick={() => void handleStartSelectedAgent()}
                        type="button"
                      >
                        {startSelectedAgentMutation.isPending ? "Starting..." : "Start"}
                      </button>
                      <button
                        className="outline-button outline-button-small"
                        disabled={interruptSelectedAgentMutation.isPending || workspaceFocusedAgent.state !== "RUNNING"}
                        onClick={() => void handleInterruptSelectedAgent()}
                        type="button"
                      >
                        {interruptSelectedAgentMutation.isPending ? "Interrupting..." : "Interrupt"}
                      </button>
                      <button
                        className="outline-button outline-button-small danger-button"
                        disabled={
                          stopSelectedAgentMutation.isPending ||
                          workspaceFocusedAgent.state === "STOPPED" ||
                          workspaceFocusedAgent.state === "COMPLETED"
                        }
                        onClick={() => void handleStopSelectedAgent()}
                        type="button"
                      >
                        {stopSelectedAgentMutation.isPending ? "Stopping..." : "Stop"}
                      </button>
                      <button
                        className="outline-button outline-button-small"
                        onClick={() => clearWorkspaceAgentFocus()}
                        type="button"
                      >
                        All agents
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="compact-notices sidebar-footer-pills">
                      <span className="compact-note">
                        {visibleTiles.length === agents.length
                          ? `${agents.length} agents`
                          : `${visibleTiles.length}/${agents.length} visible`}
                      </span>
                      {workspaceAuditErrorCount > 0 ? (
                        <span className="compact-note compact-note-danger">
                          {workspaceAuditErrorCount} error{workspaceAuditErrorCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      {workspacePulseLabel !== "Calm" ? <span className="compact-note">{workspacePulseLabel}</span> : null}
                    </div>
                    <label className="compact-select-field sidebar-stop-scope-field">
                      <select
                        className="workspace-picker"
                        value={workspaceStopScope}
                        onChange={(event) =>
                          setWorkspaceStopScope(event.target.value as "visible" | "all" | "running")
                        }
                      >
                        <option value="visible">Visible ({visibleStoppableAgents.length})</option>
                        <option value="all">All ({stoppableAgents.length})</option>
                        <option value="running">Running ({runningAgents.length})</option>
                      </select>
                    </label>
                    <button
                      className="outline-button outline-button-small danger-button"
                      disabled={stopSelectedAgentMutation.isPending || workspaceStopTargetCount === 0}
                      onClick={() => void handleStopAgents(workspaceStopScope)}
                      type="button"
                    >
                      {stopSelectedAgentMutation.isPending
                        ? "Stopping..."
                        : `Stop ${workspaceStopScope} (${workspaceStopTargetCount})`}
                    </button>
                    <button
                      className="outline-button outline-button-small"
                      onClick={() => setWorkspaceRosterExpanded((current) => !current)}
                      type="button"
                    >
                      {workspaceRosterExpanded ? "Hide roster" : "Show roster"}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </aside>

        <div
          aria-label="Resize navigation"
          className="pane-resizer pane-resizer-vertical"
          onMouseDown={(event) => {
            event.preventDefault();
            setDragState({
              target: "sidebar",
              startX: event.clientX,
              startWidth: leftRailWidth,
            });
          }}
          role="separator"
        />

        <section className="workspace-shell">
          <header className="workspace-bar panel-tone-header">
            <div className="workspace-bar-left">
              <div className="workspace-view workspace-view-compact">
                <strong>{activeMenuLabel}</strong>
              </div>
            </div>
            <div className="workspace-bar-right">
              <button
                className="outline-button"
                onClick={() => setCommandPaletteOpen(true)}
                type="button"
              >
                Command palette
              </button>
              <button
                className="menu-button"
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                type="button"
              >
                {theme === "dark" ? "Light" : "Dark"}
              </button>
              <div className="zoom-controls">
                <button className="outline-button zoom-btn" onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))} type="button" title="Zoom out (⌘-)">−</button>
                <button className="outline-button zoom-reset" onClick={() => setZoom(1)} type="button" title="Reset zoom (⌘0)">{zoom === 1 ? "100%" : `${Math.round(zoom * 100)}%`}</button>
                <button className="outline-button zoom-btn" onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10))} type="button" title="Zoom in (⌘+)">+</button>
              </div>
              {activeMenu !== "settings" && homeThread.kind !== "planner" ? (
                <button
                  className="outline-button"
                  onClick={() => setRightSidebarVisible((current) => !current)}
                  type="button"
                >
                  {rightSidebarVisible ? "Hide panel" : "Show panel"}
                </button>
              ) : null}
              <div className="workspace-select-wrap workspace-select-wrap-inline">
                <div className="workspace-select-row">
                  <select
                    aria-label="Select workspace"
                    className="workspace-picker"
                    value={activeWorkspaceId}
                    onChange={(event) => {
                      const nextWorkspaceId = event.target.value;
                      const nextWorkspace = (workspacesQuery.data ?? []).find(
                        (workspace) => workspace.id === nextWorkspaceId,
                      );
                      setActiveWorkspaceId(nextWorkspaceId);
                      setWorkspaceNameDraft(nextWorkspace?.name ?? "");
                      setDeleteWorkspaceArmed(false);
                      setHomeThread({ kind: "workspace" });
                      setSelectedAgentId("");
                      setWorkspaceFocusedAgentId("");
                      setInspectorTab("session");
                      setRightSidebarTab("files");
                      setSelectedExplorerFilePath("");
                    }}
                  >
                    <option value="">Select workspace</option>
                    {(workspacesQuery.data ?? []).map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))}
                  </select>
                  <div className="workspace-settings-anchor">
                    <button
                      aria-label="Open workspace settings"
                      ref={workspaceSettingsButtonRef}
                      className={
                        workspaceSettingsPopoverOpen
                          ? "outline-button outline-button-small workspace-settings-button button-active-soft"
                          : "outline-button outline-button-small workspace-settings-button"
                      }
                      onClick={() => {
                        setActiveMenu(null);
                        setWorkspaceSettingsPopoverOpen((current) => {
                          const next = !current;
                          if (next) {
                            syncWorkspaceSettingsPopoverPosition();
                          } else {
                            setWorkspaceSettingsPopoverPosition(null);
                          }
                          return next;
                        });
                      }}
                      title="Workspace settings"
                      type="button"
                    >
                      ⚙
                    </button>
                  </div>
                </div>
              </div>
              <div className="topbar-status compact-row">
                {isReconnecting ? (
                  <span className="settings-pill">Reconnecting…</span>
                ) : (
                  <span className={healthQuery.data?.ok ? "settings-pill settings-pill-active" : "settings-pill"}>
                    {healthQuery.data?.ok ? "connected" : "offline"}
                  </span>
                )}
                <span className={streamConnected ? "settings-pill settings-pill-active" : "settings-pill"}>
                  {streamConnected ? "stream live" : "polling"}
                </span>
              </div>
            </div>
          </header>

          {isOffline ? (
            <section className="notice-banner notice-error">
              <strong>{offlineBannerTitle}</strong>
              <p>{offlineBannerBody}</p>
            </section>
          ) : null}

          {workspaceNotice ? (
            <div
              aria-live={workspaceNotice.tone === "error" ? "assertive" : "polite"}
              className="workspace-toast-layer"
            >
              <section className={`notice-banner notice-${workspaceNotice.tone} notice-toast`}>
                <div className="notice-banner-header">
                  <strong>
                    {workspaceNotice.tone === "error"
                      ? "Action failed"
                      : workspaceNotice.tone === "success"
                        ? "Updated"
                        : "Working"}
                  </strong>
                  <button
                    aria-label="Dismiss notice"
                    className="notice-dismiss"
                    onClick={() => setWorkspaceNotice(null)}
                    type="button"
                  >
                    Dismiss
                  </button>
                </div>
                <p>{workspaceNotice.text}</p>
              </section>
            </div>
          ) : null}

          <section
            className="thread-layout"
            style={{ gridTemplateColumns: showContextRail ? `minmax(0, 1fr) 8px ${inspectorWidth}px` : "minmax(0, 1fr)" }}
          >
            <div className="thread-stage">
              {activeMenu !== null ? renderActiveMenu() : renderHomeThreadContent()}
            </div>

            {showContextRail ? (
              <>
                <div
                  aria-label="Resize right sidebar"
                  className="pane-resizer pane-resizer-vertical"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setDragState({
                      target: "inspector",
                      startX: event.clientX,
                      startWidth: inspectorWidth,
                    });
                  }}
                  role="separator"
                />

                {activeMenu === "settings" ? renderSettingsDrawer() : renderRightSidebar()}
              </>
            ) : null}
          </section>
        </section>
      </div>
      {workspaceSettingsPopoverOpen ? renderWorkspaceSettingsPopover() : null}
      {renderCommandPalette()}
    </main>
  );
}
