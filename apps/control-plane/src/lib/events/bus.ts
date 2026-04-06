import { EventEmitter } from "node:events";

import type { AgentEventRecord } from "@acc/shared-types";

type EventListener = (event: AgentEventRecord) => void;

export interface EventBus {
  publish(event: AgentEventRecord): void;
  subscribe(listener: EventListener): () => void;
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter();

  return {
    publish(event) {
      emitter.emit("agent_event", event);
    },
    subscribe(listener) {
      emitter.on("agent_event", listener);
      return () => {
        emitter.off("agent_event", listener);
      };
    },
  };
}

