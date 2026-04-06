import type { AppServices } from "./lib/services.js";

declare module "fastify" {
  interface FastifyInstance {
    acc: AppServices;
  }
}

