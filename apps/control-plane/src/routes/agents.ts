import { isAbsolute, relative, resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AgentSessionRecord } from "@acc/shared-types";

import { createId } from "../lib/ids.js";

const createAgentSchema = z.object({
  workspaceId: z.string().min(1),
  provider: z.enum(["codex", "claude", "mock"]),
  model: z.string().min(1),
  title: z.string().optional(),
  role: z.string().optional(),
  task: z.string().optional(),
  cwd: z.string().optional(),
  systemPrompt: z.string().optional(),
});

const updateAgentSchema = z
  .object({
    title: z.string().min(1).optional(),
    cwd: z.string().optional(),
  })
  .refine((body) => body.title !== undefined || body.cwd !== undefined, {
    message: "At least one agent field must be provided",
  });

const runMockSchema = z.object({
  scenario: z.enum(["planner", "reviewer", "idle", "error"]),
});

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  function isWithinRoot(root: string, target: string): boolean {
    const normalizedRoot = resolve(root);
    const normalizedTarget = resolve(target);
    const rel = relative(normalizedRoot, normalizedTarget);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  app.get("/agents", async (request) => {
    const query = z.object({ workspaceId: z.string().optional() }).parse(request.query);
    return { agents: await app.acc.repositories.agents.list(query.workspaceId) };
  });

  app.get("/agents/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    return { agent };
  });

  app.get("/agents/:id/events", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({
      cursor: z.coerce.number().int().nonnegative().optional(),
      limit: z.coerce.number().int().positive().optional(),
    }).parse(request.query);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    return {
      events: await app.acc.eventService.listAgentEvents(params.id, query.cursor, query.limit),
    };
  });

  app.get("/agents/:id/artifacts", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    return {
      artifacts: await app.acc.repositories.artifacts.listByAgent(params.id),
    };
  });

  app.get("/agents/:id/worktree", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    return {
      worktree: await app.acc.repositories.worktrees.findByAgentId(params.id),
    };
  });

  app.post("/agents", async (request, reply) => {
    const body = createAgentSchema.parse(request.body);
    const workspace = await app.acc.repositories.workspaces.findById(body.workspaceId);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    const now = new Date().toISOString();
    const cwd = body.cwd?.trim() || workspace.projectRoot || undefined;
    const metadata: Record<string, unknown> = {};

    if (body.role?.trim()) {
      metadata.role = body.role.trim();
    }

    if (cwd) {
      metadata.cwd = cwd;
    }

    if (body.systemPrompt?.trim()) {
      metadata.systemPrompt = body.systemPrompt.trim();
    }

    if (body.task?.trim()) {
      metadata.initialTask = body.task.trim();
      metadata.preview = body.task.trim().slice(0, 220);
    }

    const agent: AgentSessionRecord = {
      id: createId("ag"),
      workspaceId: body.workspaceId,
      provider: body.provider,
      model: body.model,
      title: body.title ?? body.role?.trim() ?? `${body.provider}:${body.model}`,
      state: "CREATED",
      lastEventAt: now,
      heartbeatAt: now,
      usage: {
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
      metadata,
    };

    const createdAgent = await app.acc.repositories.agents.create(agent);
    await app.acc.coordinationService.refreshWorkspaceState(body.workspaceId);
    reply.code(201);
    return { agent: createdAgent };
  });

  app.patch("/agents/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = updateAgentSchema.parse(request.body);
    const existingAgent = await app.acc.repositories.agents.findById(params.id);

    if (!existingAgent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    const workspace = await app.acc.repositories.workspaces.findById(existingAgent.workspaceId);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    const metadataPatch: Record<string, unknown> = {};
    if (body.cwd !== undefined) {
      const normalizedCwd = body.cwd.trim();

      if (!normalizedCwd) {
        metadataPatch.cwd = null;
      } else {
        const resolvedCwd = resolve(normalizedCwd);

        if (workspace.projectRoot && !isWithinRoot(workspace.projectRoot, resolvedCwd)) {
          reply.code(400);
          return {
            error: "CWD_OUTSIDE_PROJECT_ROOT",
            message: `Working directory must stay inside the workspace project root (${workspace.projectRoot}).`,
          };
        }

        metadataPatch.cwd = resolvedCwd;
      }
    }

    const updatedAgent = await app.acc.repositories.agents.update(params.id, {
      title: body.title,
      metadata: Object.keys(metadataPatch).length > 0 ? metadataPatch : undefined,
    });

    if (!updatedAgent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    await app.acc.coordinationService.refreshWorkspaceState(updatedAgent.workspaceId);

    return { agent: updatedAgent };
  });

  app.post("/agents/:id/start", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    const session = await app.acc.runtimeManager.start(params.id);

    reply.code(202);
    return {
      accepted: true,
      agentId: params.id,
      sessionId: session.sessionId,
      state: session.state,
    };
  });

  app.post("/agents/:id/input", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ input: z.string().min(1) }).parse(request.body);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    await app.acc.runtimeManager.sendInput(params.id, {
      input: body.input,
    });

    reply.code(202);
    return {
      accepted: true,
      agentId: params.id,
      input: body.input,
    };
  });

  app.post("/agents/:id/interrupt", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    await app.acc.runtimeManager.interrupt(params.id);

    reply.code(202);
    return { accepted: true, agentId: params.id };
  });

  app.post("/agents/:id/stop", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    await app.acc.runtimeManager.stop(params.id);

    reply.code(202);
    return { accepted: true, agentId: params.id };
  });

  app.post("/agents/:id/worktree/reset", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    const worktree = await app.acc.runOrchestrator.resetWorktree(params.id);
    reply.code(202);
    return {
      accepted: true,
      worktree,
    };
  });

  app.post("/agents/:id/mock-run", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = runMockSchema.parse(request.body);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    const session = await app.acc.mockRunner.start(agent, body.scenario);

    reply.code(202);
    return {
      accepted: true,
      agentId: params.id,
      scenario: body.scenario,
      sessionId: session.sessionId,
    };
  });

  app.patch("/agents/:id/auto-start", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      autoStart: z.boolean(),
      autoStartPrompt: z.string().optional(),
    }).parse(request.body);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    const updated = await app.acc.repositories.agents.update(params.id, {
      metadata: { autoStart: body.autoStart, autoStartPrompt: body.autoStartPrompt ?? null },
    });

    return { agent: updated };
  });

  app.patch("/agents/:id/capability", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      capability: z.enum(["reader", "writer", "commander", "orchestrator"]),
    }).parse(request.body);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    const updated = await app.acc.repositories.agents.update(params.id, {
      metadata: { role: body.capability },
    });

    return { agent: updated };
  });

  app.get("/agents/:id/memory", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    const blocks = await app.acc.repositories.memory.listForAgent(params.id);
    return { blocks };
  });
}
