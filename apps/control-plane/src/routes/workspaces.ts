import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AgentSessionRecord, ContextPackRecord, ContextItemRecord } from "@acc/shared-types";

import { createId } from "../lib/ids.js";
import {
  formatImportedFiles,
  importProjectFiles,
  listProjectFileCandidates,
  resolveProjectRoot,
} from "../lib/project-files.js";

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  projectRoot: z.string().optional(),
  sharedContext: z.string().optional(),
});

const plannerAgentRecommendationSchema = z.object({
  role: z.string().min(1),
  objective: z.string().min(1),
  provider: z.enum(["codex", "claude"]),
  model: z.string().min(1),
  reasoning: z.string().min(1),
});

const coordinationBriefSchema = z.object({
  savedAt: z.string().min(1),
  source: z.enum(["planner", "saved_recommendation", "manual"]),
  task: z.string().optional(),
  constraints: z.string().optional(),
  advisorProvider: z.enum(["codex", "claude"]).optional(),
  advisorModel: z.string().optional(),
  summary: z.string().min(1),
  coordinationNotes: z.array(z.string()),
  risks: z.array(z.string()),
  agents: z.array(plannerAgentRecommendationSchema),
});

const updateWorkspaceSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    projectRoot: z.string().optional(),
    sharedContext: z.string().optional(),
    coordinationBrief: coordinationBriefSchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.description !== undefined ||
      body.projectRoot !== undefined ||
      body.sharedContext !== undefined ||
      body.coordinationBrief !== undefined,
    {
    message: "At least one workspace field must be provided",
  });

const importSharedContextSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  mode: z.enum(["append", "replace"]).default("append"),
});

async function normalizeProjectRoot(projectRoot: string | undefined): Promise<string | undefined> {
  if (projectRoot === undefined) {
    return undefined;
  }

  const trimmed = projectRoot.trim();

  if (trimmed.length === 0) {
    return "";
  }

  return resolveProjectRoot(trimmed);
}

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces", async () => {
    const workspaces = await app.acc.repositories.workspaces.list();
    return { workspaces };
  });

  app.post("/workspaces", async (request, reply) => {
    const body = createWorkspaceSchema.parse(request.body);
    const projectRoot = await normalizeProjectRoot(body.projectRoot);
    const workspace = await app.acc.repositories.workspaces.create({
      id: createId("ws"),
      name: body.name,
      description: body.description ?? "",
      projectRoot: projectRoot ?? "",
      sharedContext: body.sharedContext?.trim() ?? "",
      layoutConfig: {},
    });

    reply.code(201);
    return { workspace };
  });

  app.patch("/workspaces/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = updateWorkspaceSchema.parse(request.body);
    const projectRoot = await normalizeProjectRoot(body.projectRoot);
    const existing = await app.acc.repositories.workspaces.findById(params.id);

    if (!existing) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    const workspace = await app.acc.repositories.workspaces.update(params.id, {
      ...body,
      projectRoot,
      sharedContext: body.sharedContext?.trim(),
      layoutConfig:
        body.coordinationBrief !== undefined
          ? {
              ...existing.layoutConfig,
              coordinationBrief: body.coordinationBrief,
            }
          : existing.layoutConfig,
    });

    if (body.coordinationBrief !== undefined) {
      await app.acc.coordinationService.refreshWorkspaceState(params.id, {
        brief: body.coordinationBrief,
      });
    }

    return { workspace };
  });

  app.delete("/workspaces/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const deleted = await app.acc.repositories.workspaces.delete(params.id);

    if (!deleted) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    reply.code(204);
    return null;
  });

  app.get("/workspaces/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const workspace = await app.acc.repositories.workspaces.findById(params.id);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    const [agentsSummary, contextsSummary, usageSummary, coordinationState] = await Promise.all([
      app.acc.repositories.agents.list(params.id),
      app.acc.repositories.contexts.list(params.id),
      app.acc.repositories.usage.getSummary(params.id),
      app.acc.coordinationService.getWorkspaceState(params.id),
    ]);

    return {
      workspace,
      agentsSummary,
      contextsSummary,
      usageSummary,
      coordinationState,
    };
  });

  app.get("/workspaces/:id/coordination", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const workspace = await app.acc.repositories.workspaces.findById(params.id);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    return {
      workspaceId: workspace.id,
      coordinationState: await app.acc.coordinationService.getWorkspaceState(workspace.id),
    };
  });

  app.get("/workspaces/:id/coordination/render", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z
      .object({
        agentId: z.string().optional(),
        role: z.string().optional(),
        title: z.string().optional(),
      })
      .parse(request.query);
    const workspace = await app.acc.repositories.workspaces.findById(params.id);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    return {
      workspaceId: workspace.id,
      packet: await app.acc.coordinationService.renderExecutionPacket(workspace.id, query),
    };
  });

  app.put("/workspaces/:id/coordination", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        brief: coordinationBriefSchema.nullable(),
      })
      .parse(request.body);
    const workspace = await app.acc.repositories.workspaces.findById(params.id);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    const coordinationState = await app.acc.coordinationService.refreshWorkspaceState(params.id, {
      brief: body.brief,
    });

    return {
      workspaceId: params.id,
      coordinationState,
    };
  });

  app.post("/workspaces/:id/coordination/dispatch", async (request, reply) => {
    const { id: workspaceId } = z.object({ id: z.string() }).parse(request.params);
    const { replyText, promptId, teamAskId } = z.object({
      replyText: z.string().min(1),
      promptId: z.string().min(1),
      teamAskId: z.string().optional(),
    }).parse(request.body);

    const decomposed = await app.acc.coordinationService.decomposeWorkspaceReply(workspaceId, {
      replyText,
      promptId,
      teamAskId,
    });

    if (decomposed.status !== "routed") {
      reply.code(200);
      return { workspaceId, ...decomposed, dispatchedRunIds: [] };
    }

    const dispatchedRunIds: string[] = [];
    for (const packet of decomposed.packets) {
      try {
        const run = await app.acc.runOrchestrator.startRun(packet.agentId, packet.content);
        dispatchedRunIds.push(run.id);
      } catch (err) {
        app.log.warn({ agentId: packet.agentId, err }, "dispatch: startRun failed for agent");
      }
    }

    reply.code(202);
    return {
      workspaceId,
      status: "dispatched" as const,
      dispatchedRunIds,
      blockedAgentIds: decomposed.blockedAgentIds,
    };
  });

  app.delete("/workspaces/:id/team-ask", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const workspace = await app.acc.repositories.workspaces.findById(id);
    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }
    await app.acc.repositories.coordination.dismissTeamAsk(id);
    reply.code(204);
    return null;
  });

  app.get("/workspaces/:id/project-files", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const workspace = await app.acc.repositories.workspaces.findById(params.id);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    if (!workspace.projectRoot) {
      reply.code(400);
      return { error: "Configure a project root before browsing repo files" };
    }

    const candidates = await listProjectFileCandidates(workspace.projectRoot);
    return {
      workspaceId: workspace.id,
      projectRoot: workspace.projectRoot,
      candidates,
    };
  });

  app.get("/workspaces/:id/inbox", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const workspace = await app.acc.repositories.workspaces.findById(params.id);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    return {
      workspaceId: workspace.id,
      inbox: await app.acc.repositories.handoffs.listByWorkspace(workspace.id),
      approvals: await app.acc.repositories.approvals.listPending(workspace.id),
    };
  });

  app.get("/workspaces/:id/events", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z
      .object({
        agentId: z.string().optional(),
        limit: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    const workspace = await app.acc.repositories.workspaces.findById(params.id);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    return {
      workspaceId: workspace.id,
      events: await app.acc.eventService.listWorkspaceEvents(workspace.id, {
        agentId: query.agentId,
        limit: query.limit,
      }),
    };
  });

  app.post("/workspaces/:id/shared-context/import", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = importSharedContextSchema.parse(request.body);
    const workspace = await app.acc.repositories.workspaces.findById(params.id);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    if (!workspace.projectRoot) {
      reply.code(400);
      return { error: "Configure a project root before importing repo context" };
    }

    const importedFiles = await importProjectFiles(workspace.projectRoot, body.paths);
    const formattedImport = formatImportedFiles(importedFiles);
    const nextSharedContext =
      body.mode === "replace" || workspace.sharedContext.trim().length === 0
        ? formattedImport
        : `${workspace.sharedContext.trimEnd()}\n\n${formattedImport}`;
    const updatedWorkspace = await app.acc.repositories.workspaces.update(workspace.id, {
      sharedContext: nextSharedContext,
    });

    return {
      workspace: updatedWorkspace,
      importedFiles: importedFiles.map((entry) => entry.path),
      mode: body.mode,
    };
  });

  app.post("/workspaces/:id/bootstrap-demo", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const workspace = await app.acc.repositories.workspaces.findById(params.id);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    const existingAgents = await app.acc.repositories.agents.list(params.id);
    const existingContexts = await app.acc.repositories.contexts.list(params.id);

    if (existingAgents.length > 0 || existingContexts.length > 0) {
      reply.code(409);
      return {
        error: "Workspace already contains demo content",
      };
    }

    const contextPacks: ContextPackRecord[] = [
      {
        id: createId("cp"),
        workspaceId: workspace.id,
        name: "Sprint plan v1",
        description: "Initial shared context for the planner and review agents.",
        version: 1,
        immutable: true,
        createdAt: new Date().toISOString(),
        items: [
          {
            id: createId("ci"),
            type: "text",
            value: "Goal: wire the desktop shell to the control plane and make the release path installer-friendly.",
            checksum: "text:93",
            tokenEstimate: 24,
          },
          {
            id: createId("ci"),
            type: "text",
            value: "Constraint: keep the app usable across Codex and Claude style providers.",
            checksum: "text:73",
            tokenEstimate: 19,
          },
        ],
      },
      {
        id: createId("cp"),
        workspaceId: workspace.id,
        name: "Release readiness",
        description: "Packaging notes for the release and notarization flow.",
        version: 1,
        immutable: true,
        createdAt: new Date().toISOString(),
        items: [
          {
            id: createId("ci"),
            type: "text",
            value: "Deliverable: signed and notarized macOS installer with reproducible CI steps.",
            checksum: "text:80",
            tokenEstimate: 20,
          },
        ],
      },
    ];

    for (const contextPack of contextPacks) {
      await app.acc.repositories.contexts.create(contextPack);
    }

    const demoAgents: Array<{
      title: string;
      scenario: "planner" | "reviewer" | "idle" | "error";
      provider: AgentSessionRecord["provider"];
      model: string;
      monitor: string;
      preview: string;
    }> = [
      {
        title: "Planner swarm",
        scenario: "planner",
        provider: "codex",
        model: "gpt-5-codex",
        monitor: "Monitor 1",
        preview: "Coordinating sprint ticket breakdown and assigning follow-up tasks.",
      },
      {
        title: "Claude reviewer",
        scenario: "reviewer",
        provider: "claude",
        model: "sonnet",
        monitor: "Monitor 2",
        preview: "Waiting on a release cutoff decision before completing the review pass.",
      },
      {
        title: "Infra watcher",
        scenario: "idle",
        provider: "codex",
        model: "gpt-5-codex",
        monitor: "Monitor 2",
        preview: "Finished the current queue and is now watching for new instructions.",
      },
      {
        title: "Context curator",
        scenario: "error",
        provider: "claude",
        model: "opus",
        monitor: "Monitor 3",
        preview: "Hit a simulated integration failure while preparing shared context.",
      },
    ];

    const createdAgents: AgentSessionRecord[] = [];

    for (const demoAgent of demoAgents) {
      const now = new Date().toISOString();
      const agent = await app.acc.repositories.agents.create({
        id: createId("ag"),
        workspaceId: workspace.id,
        provider: demoAgent.provider,
        model: demoAgent.model,
        title: demoAgent.title,
        state: "CREATED",
        heartbeatAt: now,
        lastEventAt: now,
        usage: {
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
        metadata: {
          monitor: demoAgent.monitor,
          preview: demoAgent.preview,
          scenario: demoAgent.scenario,
        },
      });

      createdAgents.push(agent);
    }

    await app.acc.repositories.contexts.mount(
      contextPacks[0].id,
      createdAgents.slice(0, 2).map((agent) => agent.id),
      4_000,
    );
    await app.acc.repositories.contexts.mount(
      contextPacks[1].id,
      createdAgents.slice(2).map((agent) => agent.id),
      2_500,
    );

    for (const agent of createdAgents) {
      const scenario = (agent.metadata.scenario as "planner" | "reviewer" | "idle" | "error");
      await app.acc.mockRunner.start(agent, scenario);
    }

    reply.code(201);
    return {
      workspaceId: workspace.id,
      createdAgents: createdAgents.length,
      createdContextPacks: contextPacks.length,
    };
  });
}
