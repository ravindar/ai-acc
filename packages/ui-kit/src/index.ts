export const agentStateMeta = {
  CREATED: { label: "Ready to launch", tone: "muted" },
  STARTING: { label: "Starting", tone: "info" },
  READY: { label: "Ready", tone: "success" },
  RUNNING: { label: "Running", tone: "info" },
  WAITING_INPUT: { label: "Needs input", tone: "warning" },
  WAITING_APPROVAL: { label: "Approval needed", tone: "warning" },
  WAITING_DEPENDENCY: { label: "Waiting", tone: "muted" },
  IDLE: { label: "Idle", tone: "warning" },
  COMPLETED: { label: "Completed", tone: "success" },
  ERROR: { label: "Error", tone: "danger" },
  STOPPED: { label: "Stopped", tone: "muted" },
} as const;

export const usageFormatters = {
  cost(value: number) {
    return `$${value.toFixed(2)}`;
  },
  tokens(value: number) {
    return value.toLocaleString();
  },
};
