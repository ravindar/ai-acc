import type { FastifyInstance } from "fastify";
import { z } from "zod";

export async function registerHandoffRoutes(app: FastifyInstance): Promise<void> {
  app.post("/handoffs/:id/assign", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ agentId: z.string().min(1) }).parse(request.body);
    const handoff = await app.acc.runOrchestrator.assignHandoff(params.id, body.agentId);

    if (!handoff) {
      reply.code(404);
      return { error: "Handoff not found" };
    }

    return { handoff };
  });

  app.post("/handoffs/:id/create-agent", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.runOrchestrator.createAgentFromHandoff(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Handoff not found" };
    }

    reply.code(201);
    return { agent };
  });

  app.patch("/handoffs/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      status: z.enum(["OPEN", "ASSIGNED", "DONE", "DISMISSED"]),
    }).parse(request.body);
    const handoff = await app.acc.repositories.handoffs.updateStatus(params.id, body.status);

    if (!handoff) {
      reply.code(404);
      return { error: "Handoff not found" };
    }

    await app.acc.coordinationService.refreshWorkspaceState(handoff.workspaceId);

    if (body.status === "DONE" || body.status === "DISMISSED") {
      await app.acc.coordinationService.onHandoffResolved(handoff.workspaceId, handoff.id);
    }

    return { handoff };
  });
}
