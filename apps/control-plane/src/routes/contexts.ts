import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ContextItemRecord, ContextPackRecord } from "@acc/shared-types";

import { createId } from "../lib/ids.js";

const contextItemSchema = z.object({
  type: z.enum(["file", "url", "text"]),
  value: z.string().min(1),
});

const createContextSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  items: z.array(contextItemSchema).min(1),
});

export async function registerContextRoutes(app: FastifyInstance): Promise<void> {
  app.get("/contexts", async (request) => {
    const query = z.object({ workspaceId: z.string().optional() }).parse(request.query);
    return { contextPacks: await app.acc.repositories.contexts.list(query.workspaceId) };
  });

  app.post("/contexts", async (request, reply) => {
    const body = createContextSchema.parse(request.body);
    const workspace = await app.acc.repositories.workspaces.findById(body.workspaceId);

    if (!workspace) {
      reply.code(404);
      return { error: "Workspace not found" };
    }

    const items: ContextItemRecord[] = body.items.map((item) => ({
      id: createId("ci"),
      type: item.type,
      value: item.value,
      checksum: `${item.type}:${item.value.length}`,
      tokenEstimate: Math.ceil(item.value.length / 4),
    }));

    const contextPack: ContextPackRecord = {
      id: createId("cp"),
      workspaceId: body.workspaceId,
      name: body.name,
      description: body.description ?? "",
      version: 1,
      immutable: true,
      items,
      createdAt: new Date().toISOString(),
    };

    const createdContextPack = await app.acc.repositories.contexts.create(contextPack);
    reply.code(201);
    return { contextPack: createdContextPack };
  });

  app.post("/contexts/:id/mount", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      agentIds: z.array(z.string()).min(1),
      maxContextTokens: z.number().int().positive().optional(),
    }).parse(request.body);
    const contextPack = await app.acc.repositories.contexts.findById(params.id);

    if (!contextPack) {
      reply.code(404);
      return { error: "Context pack not found" };
    }

    const uniqueAgentIds = Array.from(new Set(body.agentIds));
    const agents = await app.acc.repositories.agents.findByIds(uniqueAgentIds);

    if (agents.length !== uniqueAgentIds.length) {
      const foundIds = new Set(agents.map((agent) => agent.id));
      const missingAgentIds = uniqueAgentIds.filter((agentId) => !foundIds.has(agentId));
      reply.code(404);
      return {
        error: "Some agents were not found",
        missingAgentIds,
      };
    }

    const crossWorkspaceAgents = agents
      .filter((agent) => agent.workspaceId !== contextPack.workspaceId)
      .map((agent) => agent.id);

    if (crossWorkspaceAgents.length > 0) {
      reply.code(400);
      return {
        error: "Context pack and agents must belong to the same workspace",
        crossWorkspaceAgents,
      };
    }

    const mounted = await app.acc.repositories.contexts.mount(
      params.id,
      uniqueAgentIds,
      body.maxContextTokens,
    );

    return {
      mounted,
      contextPackId: params.id,
      maxContextTokens: body.maxContextTokens ?? null,
      workspaceId: contextPack.workspaceId,
    };
  });
}
