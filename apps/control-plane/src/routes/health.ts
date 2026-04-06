import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    service: "control-plane",
    env: app.acc.config.nodeEnv,
    now: new Date().toISOString(),
    autoMigrate: app.acc.config.autoMigrate,
  }));

  app.get("/ready", async (request, reply) => {
    try {
      await app.acc.db.ping();
      return {
        ok: true,
        service: "control-plane",
        database: "up",
        now: new Date().toISOString(),
      };
    } catch (error) {
      request.log.error({ err: error }, "readiness check failed");
      reply.code(503);
      return {
        ok: false,
        service: "control-plane",
        database: "down",
        now: new Date().toISOString(),
      };
    }
  });
}
