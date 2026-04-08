import type { FastifyInstance } from "fastify";
import { z } from "zod";

const approveSchema = z.object({
  decisionMessage: z.string().optional(),
  modifiedPayload: z.record(z.unknown()).optional(),
});

const decisionSchema = z.object({
  decisionMessage: z.string().optional(),
});

export async function registerApprovalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/approvals", async (request) => {
    const query = z.object({
      workspaceId: z.string().optional(),
    }).parse(request.query);

    return {
      approvals: await app.acc.repositories.approvals.listPending(query.workspaceId),
    };
  });

  app.post("/approvals/:id/approve", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = approveSchema.parse(request.body ?? {});
    const approval = await app.acc.runOrchestrator.approve(params.id, body.decisionMessage, body.modifiedPayload);

    if (!approval) {
      reply.code(404);
      return { error: "Approval not found" };
    }

    reply.code(202);
    return {
      accepted: true,
      approval,
    };
  });

  app.post("/approvals/:id/deny", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = decisionSchema.parse(request.body ?? {});
    const approval = await app.acc.runOrchestrator.deny(params.id, body.decisionMessage);

    if (!approval) {
      reply.code(404);
      return { error: "Approval not found" };
    }

    reply.code(202);
    return {
      accepted: true,
      approval,
    };
  });
}
