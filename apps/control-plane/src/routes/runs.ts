import type { FastifyInstance } from "fastify";
import { z } from "zod";

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  app.get("/agents/:id/runs", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    return {
      runs: await app.acc.repositories.runs.listByAgent(params.id),
    };
  });

  app.post("/agents/:id/runs", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      prompt: z.string().min(1),
      title: z.string().optional(),
    }).parse(request.body);
    const agent = await app.acc.repositories.agents.findById(params.id);

    if (!agent) {
      reply.code(404);
      return { error: "Agent not found" };
    }

    const run = await app.acc.runOrchestrator.startRun(params.id, body.prompt, body.title);
    reply.code(202);
    return {
      accepted: true,
      run,
    };
  });

  app.get("/runs/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const run = await app.acc.repositories.runs.findById(params.id);

    if (!run) {
      reply.code(404);
      return { error: "Run not found" };
    }

    return { run };
  });

  app.get("/runs/:id/transcript", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const run = await app.acc.repositories.runs.findById(params.id);

    if (!run) {
      reply.code(404);
      return { error: "Run not found" };
    }

    return {
      transcript: await app.acc.repositories.transcript.listByRun(params.id),
    };
  });

  app.get("/runs/:id/tool-calls", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const run = await app.acc.repositories.runs.findById(params.id);

    if (!run) {
      reply.code(404);
      return { error: "Run not found" };
    }

    return {
      toolCalls: await app.acc.repositories.toolCalls.listByRun(params.id),
    };
  });

  app.get("/runs/:id/artifacts", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const run = await app.acc.repositories.runs.findById(params.id);

    if (!run) {
      reply.code(404);
      return { error: "Run not found" };
    }

    return {
      artifacts: await app.acc.repositories.artifacts.listByRun(params.id),
    };
  });

  app.post("/runs/:id/stop", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const run = await app.acc.runOrchestrator.stopRun(params.id);

    if (!run) {
      reply.code(404);
      return { error: "Run not found" };
    }

    reply.code(202);
    return {
      accepted: true,
      run,
    };
  });
}
