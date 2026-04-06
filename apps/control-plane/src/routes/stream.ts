import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { EventStreamMessage } from "@acc/shared-types";

export async function registerStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/stream",
    {
      websocket: true,
    },
    (connection, request) => {
      const query = z.object({ workspaceId: z.string().optional() }).parse(request.query);
      const unsubscribe = app.acc.eventBus.subscribe((event) => {
        if (query.workspaceId && event.workspaceId !== query.workspaceId) {
          return;
        }

        const message: EventStreamMessage = {
          kind: "agent_event",
          event,
        };

        connection.send(JSON.stringify(message));
      });

      connection.on("close", () => {
        unsubscribe();
      });
    },
  );
}
