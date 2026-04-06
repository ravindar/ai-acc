import type { FastifyInstance } from "fastify";
import { z } from "zod";

export async function registerUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/usage", async (request) => {
    const query = z.object({
      workspaceId: z.string().optional(),
      window: z.enum(["1h", "24h"]).default("1h"),
    }).parse(request.query);

    return {
      window: query.window,
      summary: await app.acc.repositories.usage.getSummary(query.workspaceId),
    };
  });
}
