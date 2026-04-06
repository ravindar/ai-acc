import { describe, it, expect } from "vitest";
import type {
  CoordinationAgentBriefRecord,
  CoordinationDependencyEdge,
  CoordinationStateRecord,
  PlannerAgentRecommendation,
} from "@acc/shared-types";
import {
  classifyFindingType,
  deriveFindingSubscriptions,
  buildExecutionPlan,
} from "./coordination-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptyState(overrides: Partial<CoordinationStateRecord> = {}): CoordinationStateRecord {
  return {
    workspaceId: "ws1",
    brief: null,
    agentBriefs: [],
    handoffSummaries: [],
    findingSummaries: [],
    actionRequests: [],
    teamAsk: null,
    updatedAt: new Date().toISOString(),
    dependencyGraph: [],
    executionPlan: [],
    blockedAgents: [],
    coordinatorDecisions: [],
    replyPackets: [],
    teamAskHistory: [],
    currentPromptId: null,
    ...overrides,
  };
}

function makeAgentBrief(overrides: Partial<CoordinationAgentBriefRecord> = {}): CoordinationAgentBriefRecord {
  return {
    workspaceId: "ws1",
    agentId: "ag1",
    title: "Test Agent",
    provider: "claude",
    model: "claude-sonnet-4-6",
    executionRoot: "/tmp",
    subscribedFindingTypes: [],
    subscriptionReasons: {},
    summary: "A test agent",
    instructions: [],
    coordinationNotes: [],
    risks: [],
    sharedFindings: [],
    pendingActionRequests: [],
    relatedHandoffIds: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDependencyEdge(overrides: Partial<CoordinationDependencyEdge> = {}): CoordinationDependencyEdge {
  return {
    id: "edge1",
    fromAgentId: "ag1",
    toAgentId: "ag2",
    dependencyType: "depends_on_agent",
    sourceId: "ag1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyFindingType
// ---------------------------------------------------------------------------

describe("classifyFindingType", () => {
  it("returns 'handoff' for source=handoff (no short-circuit fields)", () => {
    expect(classifyFindingType({ source: "handoff" })).toBe("handoff");
  });

  it("returns 'blocker' for source=error", () => {
    expect(classifyFindingType({ source: "error" })).toBe("blocker");
  });

  it("short-circuits with transcriptMetadata.findingType when valid", () => {
    expect(
      classifyFindingType({
        source: "assistant_reply",
        transcriptMetadata: { findingType: "architecture" },
      }),
    ).toBe("architecture");
  });

  it("ignores transcriptMetadata.findingType when not a valid CoordinationFindingType", () => {
    const result = classifyFindingType({
      source: "assistant_reply",
      transcriptMetadata: { findingType: "UNKNOWN_TYPE" },
      summary: "blocked waiting for approval",
    });
    // Falls through to text heuristics → 'blocker'
    expect(result).toBe("blocker");
  });

  it("returns 'blocker' for approvalStatus=DENIED", () => {
    expect(
      classifyFindingType({ source: "assistant_reply", approvalStatus: "DENIED" }),
    ).toBe("blocker");
  });

  it("returns 'blocker' for toolCallStatus=error", () => {
    expect(
      classifyFindingType({ source: "assistant_reply", toolCallStatus: "error" }),
    ).toBe("blocker");
  });

  it("returns 'blocker' for toolCallStatus=denied", () => {
    expect(
      classifyFindingType({ source: "assistant_reply", toolCallStatus: "denied" }),
    ).toBe("blocker");
  });

  it("returns 'handoff' for handoffStatus=OPEN", () => {
    expect(
      classifyFindingType({ source: "assistant_reply", handoffStatus: "OPEN" }),
    ).toBe("handoff");
  });

  it("returns 'handoff' for handoffStatus=ASSIGNED", () => {
    expect(
      classifyFindingType({ source: "assistant_reply", handoffStatus: "ASSIGNED" }),
    ).toBe("handoff");
  });

  it("classifies 'blocker' via text heuristics", () => {
    expect(
      classifyFindingType({ source: "assistant_reply", summary: "I am stuck waiting for input" }),
    ).toBe("blocker");
  });

  it("classifies 'architecture' via text heuristics", () => {
    expect(
      classifyFindingType({ source: "assistant_reply", summary: "Proposed system boundary between modules" }),
    ).toBe("architecture");
  });

  it("returns 'general' when no signals match", () => {
    expect(
      classifyFindingType({ source: "assistant_reply", summary: "All done, looks good." }),
    ).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// deriveFindingSubscriptions
// ---------------------------------------------------------------------------

describe("deriveFindingSubscriptions", () => {
  const baseAgent = {
    id: "ag1",
    workspaceId: "ws1",
    provider: "claude" as const,
    model: "claude-sonnet-4-6",
    title: "Generic Agent",
    state: "IDLE" as const,
    lastEventAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    usage: { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 },
    metadata: {},
  };

  it("always includes baseline types for an agent with no role hints", () => {
    const { types, reasons } = deriveFindingSubscriptions(baseAgent, null);
    expect(types).toContain("decision");
    expect(types).toContain("blocker");
    expect(types).toContain("handoff");
    expect(reasons.decision).toBe("baseline:decision");
    expect(reasons.blocker).toBe("baseline:blocker");
    expect(reasons.handoff).toBe("baseline:handoff");
  });

  it("adds architecture, dependency, risk for architect role", () => {
    const agent = { ...baseAgent, title: "architect" };
    const { types } = deriveFindingSubscriptions(agent, null);
    expect(types).toContain("architecture");
    expect(types).toContain("dependency");
    expect(types).toContain("risk");
  });

  it("adds test, risk, blocker for qa role", () => {
    const agent = { ...baseAgent, title: "qa engineer" };
    const { types } = deriveFindingSubscriptions(agent, null);
    expect(types).toContain("test");
    expect(types).toContain("risk");
    expect(types).toContain("blocker");
  });

  it("uses planner recommendation role in reason string", () => {
    const recommendation: PlannerAgentRecommendation = {
      role: "Frontend Engineer",
      objective: "Build UI",
      provider: "claude",
      model: "claude-sonnet-4-6",
      reasoning: "Handles frontend implementation",
    };
    const { types, reasons } = deriveFindingSubscriptions(baseAgent, recommendation);
    expect(types).toContain("implementation");
    expect(reasons.implementation).toContain("Frontend Engineer");
  });

  it("does not overwrite baseline reasons when role also matches", () => {
    // "release" role matches ops rule which tries to add decision/blocker, but they're already baseline
    const agent = { ...baseAgent, title: "release engineer" };
    const { reasons } = deriveFindingSubscriptions(agent, null);
    expect(reasons.decision).toBe("baseline:decision");
    expect(reasons.blocker).toBe("baseline:blocker");
  });
});

// ---------------------------------------------------------------------------
// buildExecutionPlan
// ---------------------------------------------------------------------------

describe("buildExecutionPlan", () => {
  it("assigns run_now to all agents when dependencyGraph is empty", () => {
    const briefs = [
      makeAgentBrief({ agentId: "ag1", executionOrder: 0 }),
      makeAgentBrief({ agentId: "ag2", executionOrder: 1 }),
    ];
    const state = makeEmptyState();
    const { executionPlan, blockedAgents } = buildExecutionPlan(state, briefs);

    expect(executionPlan).toHaveLength(2);
    expect(executionPlan[0]!.decision).toBe("run_now");
    expect(executionPlan[1]!.decision).toBe("run_now");
    expect(blockedAgents).toHaveLength(0);
  });

  it("assigns wait to an agent with an unresolved dependency edge", () => {
    const briefs = [
      makeAgentBrief({ agentId: "ag1", executionOrder: 0 }),
      makeAgentBrief({ agentId: "ag2", executionOrder: 1 }),
    ];
    const edge = makeDependencyEdge({ fromAgentId: "ag1", toAgentId: "ag2", id: "e1" });
    const state = makeEmptyState({ dependencyGraph: [edge] });

    const { executionPlan, blockedAgents } = buildExecutionPlan(state, briefs);

    const ag2Plan = executionPlan.find((e) => e.agentId === "ag2");
    expect(ag2Plan?.decision).toBe("wait");
    expect(blockedAgents).toHaveLength(1);
    expect(blockedAgents[0]!.agentId).toBe("ag2");
    expect(blockedAgents[0]!.dependencyId).toBe("e1");
  });

  it("does NOT block an agent when its dependency edge is resolved", () => {
    const briefs = [
      makeAgentBrief({ agentId: "ag1", executionOrder: 0 }),
      makeAgentBrief({ agentId: "ag2", executionOrder: 1 }),
    ];
    const edge = makeDependencyEdge({
      fromAgentId: "ag1",
      toAgentId: "ag2",
      resolvedAt: new Date().toISOString(),
    });
    const state = makeEmptyState({ dependencyGraph: [edge] });

    const { executionPlan, blockedAgents } = buildExecutionPlan(state, briefs);

    const ag2Plan = executionPlan.find((e) => e.agentId === "ag2");
    expect(ag2Plan?.decision).toBe("run_now");
    expect(blockedAgents).toHaveLength(0);
  });

  it("sorts agents by executionOrder ascending", () => {
    const briefs = [
      makeAgentBrief({ agentId: "ag2", executionOrder: 1 }),
      makeAgentBrief({ agentId: "ag1", executionOrder: 0 }),
    ];
    const state = makeEmptyState();
    const { executionPlan } = buildExecutionPlan(state, briefs);

    expect(executionPlan[0]!.agentId).toBe("ag1");
    expect(executionPlan[1]!.agentId).toBe("ag2");
  });

  it("puts agents without executionOrder last", () => {
    const briefs = [
      makeAgentBrief({ agentId: "ag-no-order" }),
      makeAgentBrief({ agentId: "ag1", executionOrder: 0 }),
    ];
    const state = makeEmptyState();
    const { executionPlan } = buildExecutionPlan(state, briefs);

    expect(executionPlan[0]!.agentId).toBe("ag1");
    expect(executionPlan[1]!.agentId).toBe("ag-no-order");
  });

  it("assigns ask_user when agent has a pending approval action request", () => {
    const briefs = [makeAgentBrief({ agentId: "ag1" })];
    const state = makeEmptyState({
      actionRequests: [
        {
          id: "req1",
          workspaceId: "ws1",
          agentId: "ag1",
          agentTitle: "Agent 1",
          kind: "approval",
          title: "Needs approval",
          summary: "Waiting for your approval",
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const { executionPlan } = buildExecutionPlan(state, briefs);

    expect(executionPlan[0]!.decision).toBe("ask_user");
  });

  it("order field matches the sorted position", () => {
    const briefs = [
      makeAgentBrief({ agentId: "ag1", executionOrder: 0 }),
      makeAgentBrief({ agentId: "ag2", executionOrder: 1 }),
      makeAgentBrief({ agentId: "ag3", executionOrder: 2 }),
    ];
    const state = makeEmptyState();
    const { executionPlan } = buildExecutionPlan(state, briefs);

    expect(executionPlan[0]!.order).toBe(0);
    expect(executionPlan[1]!.order).toBe(1);
    expect(executionPlan[2]!.order).toBe(2);
  });
});
