import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { refreshPricingCache } from "@acc/pricing";
import Fastify from "fastify";
import { ZodError } from "zod";

import type { AppServices } from "./lib/services.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerContextRoutes } from "./routes/contexts.js";
import { registerHandoffRoutes } from "./routes/handoffs.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPlannerRoutes } from "./routes/planner.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerStreamRoutes } from "./routes/stream.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";

export async function createApp(services: AppServices) {
  const app = Fastify({
    logger: {
      level: services.config.logLevel,
      base: {
        service: "control-plane",
      },
    },
  });

  app.decorate("acc", services);
  await app.register(cors, {
    origin: ["http://127.0.0.1:7711", "http://localhost:7711", "tauri://localhost"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(websocket);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: "Request validation failed",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const statusCode =
      typeof (error as { statusCode?: number }).statusCode === "number" &&
      (error as { statusCode: number }).statusCode >= 400 &&
      (error as { statusCode: number }).statusCode < 600
        ? (error as { statusCode: number }).statusCode
        : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    } else {
      request.log.warn({ err: error }, "request failed");
    }

    const message = error instanceof Error ? error.message : "Request failed";

    reply.code(statusCode).send({
      error: statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR",
      message: statusCode >= 500 ? "Unexpected server error" : message,
    });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: "NOT_FOUND",
      message: `Route ${request.method} ${request.url} was not found`,
    });
  });
  app.addHook("onClose", async () => {
    await services.db.close();
  });

  void refreshPricingCache(); // non-blocking; falls back to baseline if ACC_PRICING_URL not set

  await registerHealthRoutes(app);
  await app.register(async (api) => {
    await registerWorkspaceRoutes(api);
    await registerAgentRoutes(api);
    await registerRunRoutes(api);
    await registerApprovalRoutes(api);
    await registerHandoffRoutes(api);
    await registerContextRoutes(api);
    await registerUsageRoutes(api);
    await registerPlannerRoutes(api);
    await registerStreamRoutes(api);
  }, { prefix: "/api/v1" });

  return app;
}
