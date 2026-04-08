import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  AgentRunRecord,
  AgentSessionRecord,
  HandoffItemRecord,
  ToolCallRecord,
  ToolCallStatus,
  WorkspaceRecord,
  WorktreeRecord,
} from "@acc/shared-types";

import type { AppConfig } from "../config.js";
import type { CoordinationService } from "./coordination-state.js";
import { createId } from "./ids.js";
import type { Repositories } from "./repositories.js";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TREE_ENTRIES = 300;
const MAX_SEARCH_RESULTS = 40;
const COMMAND_TIMEOUT_MS = 30_000;
const AUTO_APPROVED_TOOLS = new Set([
  "list_tree",
  "read_file",
  "search_files",
  "git_status",
  "git_diff",
  "run_verification_command",
  "create_handoff",
  "write_memory",
  "read_memory",
  "delete_memory",
  "read_peer_output",
  "send_agent_message",
  "mark_message_read",
  "update_shared_context",
]);
const APPROVAL_REQUIRED_TOOLS = new Set(["write_file", "apply_patch", "run_command"]);

type LoggerLike = Pick<Console, "error" | "info" | "warn">;

type ToolDefinition = {
  name: string;
  approval: "auto" | "manual";
  description: string;
  argumentsSummary: string;
  inputSchema: Record<string, unknown>;
};

type ToolExecutionContext = {
  run: AgentRunRecord;
  agent: AgentSessionRecord;
  workspace: WorkspaceRecord;
  worktree?: WorktreeRecord | null;
};

export type ToolExecutionResult = {
  status: ToolCallStatus;
  output: Record<string, unknown>;
  artifactIds?: string[];
};

type VerificationCommandSpec = {
  label: string;
  command: string;
  args: string[];
};

async function runCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8,
      timeout: COMMAND_TIMEOUT_MS,
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        SHELL: process.env.SHELL ?? "/bin/zsh",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        TERM: "xterm-256color",
      },
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    const execError = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };

    return {
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? execError.message,
      exitCode: typeof execError.code === "number" ? execError.code : 1,
    };
  }
}

function shellQuote(value: string): string {
  if (!value) {
    return "''";
  }

  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function isTextFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return ![".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".pdf", ".zip", ".tar", ".gz", ".woff", ".woff2"].includes(extension);
}

function ensureWithinRoot(root: string, requestedPath: string | undefined): string {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, requestedPath ?? ".");
  const rel = relative(normalizedRoot, target);

  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Requested path escapes the worktree root: ${requestedPath ?? "."}`);
  }

  return target;
}

async function listTree(root: string, requestedPath: string | undefined, depth: number, results: string[], currentDepth: number): Promise<void> {
  if (results.length >= MAX_TREE_ENTRIES || currentDepth > depth) {
    return;
  }

  const absolute = ensureWithinRoot(root, requestedPath);
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (results.length >= MAX_TREE_ENTRIES) {
      break;
    }

    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") {
      continue;
    }

    const childPath = resolve(absolute, entry.name);
    results.push(relative(root, childPath) || ".");

    if (entry.isDirectory()) {
      await listTree(root, relative(root, childPath), depth, results, currentDepth + 1);
    }
  }
}

async function searchFiles(root: string, query: string, requestedPath?: string): Promise<Array<{ path: string; line: number; text: string }>> {
  const results: Array<{ path: string; line: number; text: string }> = [];
  const startPath = ensureWithinRoot(root, requestedPath);
  const stack = [startPath];

  while (stack.length > 0 && results.length < MAX_SEARCH_RESULTS) {
    const current = stack.pop() as string;
    const currentStat = await stat(current);

    if (currentStat.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") {
          continue;
        }
        stack.push(resolve(current, entry.name));
      }
      continue;
    }

    if (!isTextFile(current) || currentStat.size > MAX_FILE_BYTES) {
      continue;
    }

    const content = await readFile(current, "utf8");
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length && results.length < MAX_SEARCH_RESULTS; index += 1) {
      if (lines[index].toLowerCase().includes(query.toLowerCase())) {
        results.push({
          path: relative(root, current),
          line: index + 1,
          text: lines[index].slice(0, 300),
        });
      }
    }
  }

  return results;
}

async function discoverVerificationCommands(repoRoot: string): Promise<VerificationCommandSpec[]> {
  const commands = new Map<string, VerificationCommandSpec>();

  const packageJsonPath = resolve(repoRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = packageJson.scripts ?? {};
      for (const scriptName of ["build", "test", "lint", "typecheck", "check"]) {
        if (scripts[scriptName]) {
          commands.set(`pnpm ${scriptName}`, {
            label: `pnpm ${scriptName}`,
            command: "pnpm",
            args: [scriptName],
          });
        }
      }
    } catch {
      // ignore malformed package.json and keep looking for other toolchains
    }
  }

  if (existsSync(resolve(repoRoot, "Cargo.toml"))) {
    commands.set("cargo check", {
      label: "cargo check",
      command: "cargo",
      args: ["check"],
    });
    commands.set("cargo test", {
      label: "cargo test",
      command: "cargo",
      args: ["test"],
    });
    commands.set("cargo build", {
      label: "cargo build",
      command: "cargo",
      args: ["build"],
    });
  }

  return [...commands.values()];
}

export interface ToolBroker {
  listTools(context: { workspace: WorkspaceRecord; worktree?: WorktreeRecord | null }): Promise<ToolDefinition[]>;
  requiresApproval(toolName: string): boolean;
  execute(context: ToolExecutionContext, call: ToolCallRecord): Promise<ToolExecutionResult>;
}

export function createToolBroker(
  config: AppConfig,
  repositories: Repositories,
  coordinationService: CoordinationService,
  logger: LoggerLike = console,
): ToolBroker {
  async function writeArtifact(run: AgentRunRecord, kind: "log" | "file" | "patch" | "trace", filename: string, contents: string): Promise<string> {
    const artifactDir = resolve(config.storageDir, "artifacts", run.id);
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = resolve(artifactDir, filename);
    await writeFile(artifactPath, contents, "utf8");

    const artifact = await repositories.artifacts.create({
      id: createId("art"),
      workspaceId: run.workspaceId,
      agentId: run.agentId,
      runId: run.id,
      kind,
      uri: artifactPath,
      sizeBytes: Buffer.byteLength(contents, "utf8"),
      createdAt: new Date().toISOString(),
    });

    return artifact.id;
  }

  function requireWorktree(context: ToolExecutionContext): WorktreeRecord {
    if (!context.worktree) {
      throw new Error("This workspace is not configured for tool-based repo execution.");
    }

    return context.worktree;
  }

  return {
    async listTools({ workspace, worktree }) {
      const tools: ToolDefinition[] = [
        {
          name: "create_handoff",
          approval: "auto",
          description: "Create a structured handoff for another agent.",
          argumentsSummary: "{ title, summary, recommendedProvider, recommendedModel, nextPrompt, artifactIds? }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "Short title for the follow-up task." },
              summary: { type: "string", description: "Concise summary of what happened and what matters next." },
              recommendedProvider: {
                type: "string",
                enum: ["codex", "claude"],
                description: "Recommended provider for the follow-up agent.",
              },
              recommendedModel: { type: "string", description: "Recommended model for the follow-up agent." },
              nextPrompt: { type: "string", description: "Prompt to hand to the next agent." },
              artifactIds: {
                type: "array",
                items: { type: "string" },
                description: "Optional artifact IDs that the next agent should inspect.",
              },
              autoSpawn: {
                type: "boolean",
                description: "If true, automatically create and start a new agent for this handoff.",
              },
            },
            required: ["title", "summary", "recommendedProvider", "recommendedModel", "nextPrompt"],
          },
        },
        {
          name: "write_memory",
          approval: "auto",
          description: "Write a key-value pair to agent memory (private or workspace-scoped). Supports optional TTL.",
          argumentsSummary: "{ key, value, scope, ttlSeconds? }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string", description: "Memory key (max 128 chars)." },
              value: { type: "string", description: "Memory value to store." },
              scope: {
                type: "string",
                enum: ["private", "workspace"],
                description: "private: only this agent can read. workspace: all agents in workspace can read.",
              },
              ttlSeconds: {
                type: "number",
                minimum: 1,
                description: "Optional: seconds until this memory block expires and is automatically deleted. Omit for permanent storage.",
              },
            },
            required: ["key", "value", "scope"],
          },
        },
        {
          name: "read_memory",
          approval: "auto",
          description: "Read memory blocks. Optionally filter by key, scope, or agentId. Expired blocks are excluded.",
          argumentsSummary: "{ key?, scope?, agentId? }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string", description: "Optional: filter to a specific key." },
              scope: {
                type: "string",
                enum: ["private", "workspace"],
                description: "Optional: filter by scope.",
              },
              agentId: { type: "string", description: "Optional: filter to a specific agent (workspace scope only)." },
            },
            required: [],
          },
        },
        {
          name: "delete_memory",
          approval: "auto",
          description: "Delete a memory block by key. Only blocks written by this agent can be deleted.",
          argumentsSummary: "{ key }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string", description: "The memory key to delete." },
            },
            required: ["key"],
          },
        },
        {
          name: "read_peer_output",
          approval: "auto",
          description: "Read transcript entries and artifacts from a peer agent's run.",
          argumentsSummary: "{ agentId, runId?, lastN? }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              agentId: { type: "string", description: "The peer agent ID to read output from." },
              runId: { type: "string", description: "Optional: specific run ID. Defaults to the peer's latest run." },
              lastN: { type: "integer", minimum: 1, maximum: 200, description: "Max transcript entries to return (default 50)." },
            },
            required: ["agentId"],
          },
        },
        {
          name: "send_agent_message",
          approval: "auto",
          description: "Send an async message to a peer agent in the same workspace.",
          argumentsSummary: "{ toAgentId, subject, content }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              toAgentId: { type: "string", description: "Recipient agent ID." },
              subject: { type: "string", maxLength: 140, description: "Message subject (max 140 chars)." },
              content: { type: "string", description: "Message body." },
            },
            required: ["toAgentId", "subject", "content"],
          },
        },
        {
          name: "mark_message_read",
          approval: "auto",
          description: "Acknowledge a received agent message as read.",
          argumentsSummary: "{ messageId }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              messageId: { type: "string", description: "The message ID to mark as read." },
            },
            required: ["messageId"],
          },
        },
        {
          name: "update_shared_context",
          approval: "auto",
          description: "Write a key-value pair to the workspace shared context visible to all agents.",
          argumentsSummary: "{ key, value }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string", maxLength: 128, description: "Context key (max 128 chars)." },
              value: { type: "string", description: "Context value." },
            },
            required: ["key", "value"],
          },
        },
      ];

      if (!worktree || !workspace.projectRoot.trim()) {
        return tools;
      }

      const verificationCommands = await discoverVerificationCommands(worktree.repoRoot);

      tools.push(
        {
          name: "list_tree",
          approval: "auto",
          description: "List files and directories inside the agent worktree.",
          argumentsSummary: "{ path?, depth? }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string", description: "Optional relative path to start listing from." },
              depth: { type: "integer", minimum: 1, maximum: 5, description: "Maximum directory depth to traverse." },
            },
            required: [],
          },
        },
        {
          name: "read_file",
          approval: "auto",
          description: "Read a UTF-8 file inside the agent worktree.",
          argumentsSummary: "{ path }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string", description: "Relative file path inside the worktree." },
            },
            required: ["path"],
          },
        },
        {
          name: "search_files",
          approval: "auto",
          description: "Search for matching text inside files in the agent worktree.",
          argumentsSummary: "{ query, path? }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", description: "Case-insensitive search text." },
              path: { type: "string", description: "Optional relative directory or file path to scope the search." },
            },
            required: ["query"],
          },
        },
        {
          name: "git_status",
          approval: "auto",
          description: "Show git status for the agent worktree.",
          argumentsSummary: "{}",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
        {
          name: "git_diff",
          approval: "auto",
          description: "Show the current git diff for the agent worktree.",
          argumentsSummary: "{}",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
        {
          name: "write_file",
          approval: "manual",
          description: "Write a UTF-8 file inside the agent worktree.",
          argumentsSummary: "{ path, content }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string", description: "Relative file path inside the worktree." },
              content: { type: "string", description: "Full file contents to write." },
            },
            required: ["path", "content"],
          },
        },
        {
          name: "apply_patch",
          approval: "manual",
          description: "Apply a unified diff patch inside the agent worktree.",
          argumentsSummary: "{ patch }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              patch: { type: "string", description: "Unified diff patch text to apply with git apply." },
            },
            required: ["patch"],
          },
        },
        {
          name: "run_command",
          approval: "manual",
          description: "Run an operator-approved shell command inside the agent worktree.",
          argumentsSummary: "{ command, args?, cwd? }",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string", description: "Executable or shell command to run." },
              args: {
                type: "array",
                items: { type: "string" },
                description: "Optional argument list for the command.",
              },
              cwd: { type: "string", description: "Optional relative path inside the worktree to run from." },
            },
            required: ["command"],
          },
        },
      );

      if (verificationCommands.length > 0) {
        tools.push({
          name: "run_verification_command",
          approval: "auto",
          description: "Run an allowed verification command discovered from the repo.",
          argumentsSummary: `{ command } where command is one of: ${verificationCommands.map((item) => item.label).join(", ")}`,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: {
                type: "string",
                enum: verificationCommands.map((item) => item.label),
                description: "One of the repo-discovered verification commands.",
              },
            },
            required: ["command"],
          },
        });
      }

      return tools;
    },

    requiresApproval(toolName) {
      if (APPROVAL_REQUIRED_TOOLS.has(toolName)) {
        return true;
      }

      return !AUTO_APPROVED_TOOLS.has(toolName);
    },

    async execute(context, call) {
      const input = call.input;

      switch (call.toolName) {
        case "list_tree": {
          const worktree = requireWorktree(context);
          const entries: string[] = [];
          await listTree(worktree.path, typeof input.path === "string" ? input.path : ".", Math.max(1, Math.min(5, Number(input.depth ?? 2))), entries, 0);
          return {
            status: "completed",
            output: {
              root: worktree.path,
              entries,
              truncated: entries.length >= MAX_TREE_ENTRIES,
            },
          };
        }
        case "read_file": {
          const worktree = requireWorktree(context);
          const filePath = ensureWithinRoot(worktree.path, typeof input.path === "string" ? input.path : undefined);
          const content = await readFile(filePath, "utf8");
          return {
            status: "completed",
            output: {
              path: relative(worktree.path, filePath),
              content: content.slice(0, MAX_FILE_BYTES),
              truncated: Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES,
            },
          };
        }
        case "search_files": {
          const worktree = requireWorktree(context);
          if (typeof input.query !== "string" || !input.query.trim()) {
            throw new Error("search_files requires a non-empty query.");
          }
          return {
            status: "completed",
            output: {
              query: input.query,
              results: await searchFiles(worktree.path, input.query, typeof input.path === "string" ? input.path : undefined),
            },
          };
        }
        case "git_status": {
          const worktree = requireWorktree(context);
          const result = await runCommand("git", ["status", "--short", "--branch"], worktree.path);
          return {
            status: result.exitCode === 0 ? "completed" : "error",
            output: result,
          };
        }
        case "git_diff": {
          const worktree = requireWorktree(context);
          const result = await runCommand("git", ["diff", "--", "."], worktree.path);
          const artifactIds = result.stdout
            ? [await writeArtifact(context.run, "patch", `git-diff-${call.id}.patch`, result.stdout)]
            : [];
          return {
            status: result.exitCode === 0 ? "completed" : "error",
            output: result,
            artifactIds,
          };
        }
        case "run_verification_command": {
          const worktree = requireWorktree(context);
          const requested = typeof input.command === "string" ? input.command.trim() : "";
          const commands = await discoverVerificationCommands(worktree.repoRoot);
          const match = commands.find((command) => command.label === requested);

          if (!match) {
            throw new Error(`Verification command is not allowed: ${requested || "(empty)"}`);
          }

          const result = await runCommand(match.command, match.args, worktree.path);
          const artifactIds = [
            await writeArtifact(
              context.run,
              "log",
              `verification-${call.id}.log`,
              [`$ ${match.label}`, "", result.stdout, result.stderr].filter(Boolean).join("\n"),
            ),
          ];

          return {
            status: result.exitCode === 0 ? "completed" : "error",
            output: {
              command: match.label,
              ...result,
            },
            artifactIds,
          };
        }
        case "write_file": {
          const worktree = requireWorktree(context);
          const filePath = ensureWithinRoot(worktree.path, typeof input.path === "string" ? input.path : undefined);
          const content = typeof input.content === "string" ? input.content : "";
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content, "utf8");
          const artifactIds = [
            await repositories.artifacts.create({
              id: createId("art"),
              workspaceId: context.run.workspaceId,
              agentId: context.run.agentId,
              runId: context.run.id,
              kind: "file",
              uri: filePath,
              sizeBytes: Buffer.byteLength(content, "utf8"),
              createdAt: new Date().toISOString(),
            }).then((artifact) => artifact.id),
          ];
          return {
            status: "completed",
            output: {
              path: relative(worktree.path, filePath),
              bytesWritten: Buffer.byteLength(content, "utf8"),
            },
            artifactIds,
          };
        }
        case "apply_patch": {
          const worktree = requireWorktree(context);
          const patch = typeof input.patch === "string" ? input.patch : "";
          const patchArtifactId = await writeArtifact(context.run, "patch", `apply-patch-${call.id}.patch`, patch);
          const patchPath = resolve(config.storageDir, "artifacts", context.run.id, `apply-patch-${call.id}.patch`);
          const result = await runCommand("git", ["apply", "--whitespace=nowarn", patchPath], worktree.path);
          return {
            status: result.exitCode === 0 ? "completed" : "error",
            output: result,
            artifactIds: [patchArtifactId],
          };
        }
        case "run_command": {
          const worktree = requireWorktree(context);
          const command = typeof input.command === "string" ? input.command.trim() : "";
          if (!command) {
            throw new Error("run_command requires a shell command.");
          }
          const args = Array.isArray(input.args)
            ? input.args.filter((value): value is string => typeof value === "string")
            : [];
          // Intentional: cwd is restricted to workspace projectRoot for security. See Phase 11 security review.
          const cwd = ensureWithinRoot(worktree.path, typeof input.cwd === "string" ? input.cwd : ".");
          const commandLine = args.length > 0 ? [command, ...args].map(shellQuote).join(" ") : command;
          const result = await runCommand("/bin/zsh", ["-lc", commandLine], cwd);
          const artifactIds = [
            await writeArtifact(
              context.run,
              "log",
              `command-${call.id}.log`,
              [`$ ${commandLine}`, "", result.stdout, result.stderr].filter(Boolean).join("\n"),
            ),
          ];
          return {
            status: result.exitCode === 0 ? "completed" : "error",
            output: {
              command,
              args,
              cwd,
              commandLine,
              ...result,
            },
            artifactIds,
          };
        }
        case "create_handoff": {
          const recommendedProvider = input.recommendedProvider === "claude" ? "claude" : "codex";
          const handoff = await repositories.handoffs.create({
            id: createId("hof"),
            workspaceId: context.run.workspaceId,
            sourceAgentId: context.run.agentId,
            sourceRunId: context.run.id,
            assignedAgentId: undefined,
            title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : `${context.agent.title} follow-up`,
            summary: typeof input.summary === "string" ? input.summary : "",
            recommendedProvider,
            recommendedModel: typeof input.recommendedModel === "string" && input.recommendedModel.trim() ? input.recommendedModel.trim() : context.agent.model,
            nextPrompt: typeof input.nextPrompt === "string" ? input.nextPrompt : "",
            artifactIds: Array.isArray(input.artifactIds)
              ? input.artifactIds.filter((item): item is string => typeof item === "string")
              : [],
            autoAssign: input.autoSpawn === true,
            status: "OPEN",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } satisfies HandoffItemRecord);
          await coordinationService.refreshWorkspaceState(context.run.workspaceId);
          await coordinationService.onHandoffCreated(context.run.workspaceId, handoff.id);

          return {
            status: "completed",
            output: {
              handoffId: handoff.id,
              title: handoff.title,
              status: handoff.status,
            },
          };
        }
        case "write_memory": {
          const key = (typeof input.key === "string" ? input.key : "").slice(0, 128);
          if (!key) throw new Error("write_memory requires a non-empty key.");
          const scope = input.scope === "workspace" ? "workspace" : "private";
          const ttlSeconds = typeof input.ttlSeconds === "number" && input.ttlSeconds > 0 ? input.ttlSeconds : null;
          const now = new Date().toISOString();
          const expiresAt = ttlSeconds !== null
            ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
            : null;
          const block = await repositories.memory.upsert({
            id: createId("mem"),
            workspaceId: context.run.workspaceId,
            agentId: context.run.agentId,
            key,
            value: typeof input.value === "string" ? input.value : String(input.value ?? ""),
            scope,
            expiresAt,
            version: 1,
            createdAt: now,
            updatedAt: now,
          });
          return {
            status: "completed",
            output: {
              key: block.key,
              scope: block.scope,
              version: block.version,
              expiresAt: block.expiresAt ?? null,
              updatedAt: block.updatedAt,
            },
          };
        }
        case "read_memory": {
          const scopeFilter = input.scope === "private" ? "private" : input.scope === "workspace" ? "workspace" : null;
          const keyFilter = typeof input.key === "string" ? input.key : null;
          const agentIdFilter = typeof input.agentId === "string" ? input.agentId : null;

          if (agentIdFilter) {
            const peerAgent = await repositories.agents.findById(agentIdFilter);
            if (!peerAgent || peerAgent.workspaceId !== context.run.workspaceId) {
              throw new Error(`Agent ${agentIdFilter} not found in this workspace.`);
            }
          }

          let blocks = await (async () => {
            if (scopeFilter === "workspace") {
              const ws = await repositories.memory.listWorkspaceScoped(context.run.workspaceId);
              return agentIdFilter ? ws.filter((b) => b.agentId === agentIdFilter) : ws;
            }
            if (scopeFilter === "private") {
              return (await repositories.memory.listForAgent(context.run.agentId)).filter((b) => b.scope === "private");
            }
            // No scope filter: own private + all workspace-scoped
            const [ownAll, wsScoped] = await Promise.all([
              repositories.memory.listForAgent(context.run.agentId),
              repositories.memory.listWorkspaceScoped(context.run.workspaceId),
            ]);
            const seen = new Set<string>();
            const combined = [];
            for (const b of [...ownAll, ...wsScoped]) {
              const dedupeKey = `${b.agentId}:${b.key}`;
              if (!seen.has(dedupeKey)) { seen.add(dedupeKey); combined.push(b); }
            }
            return combined;
          })();

          if (keyFilter) blocks = blocks.filter((b) => b.key === keyFilter);

          return {
            status: "completed",
            output: {
              blocks: blocks.map((b) => ({
                key: b.key,
                value: b.value,
                scope: b.scope,
                agentId: b.agentId,
                version: b.version,
                expiresAt: b.expiresAt ?? null,
                updatedAt: b.updatedAt,
              })),
              count: blocks.length,
            },
          };
        }
        case "delete_memory": {
          const key = (typeof input.key === "string" ? input.key : "").trim();
          if (!key) throw new Error("delete_memory requires a non-empty key.");
          const existing = await repositories.memory.findByAgentAndKey(context.run.agentId, key);
          if (!existing) {
            return { status: "completed", output: { deleted: false, key, reason: "Not found" } };
          }
          await repositories.memory.deleteByAgentAndKey(context.run.agentId, key);
          return { status: "completed", output: { deleted: true, key } };
        }
        case "read_peer_output": {
          const peerAgentId = typeof input.agentId === "string" ? input.agentId : "";
          if (!peerAgentId) throw new Error("read_peer_output requires agentId.");
          const peerAgent = await repositories.agents.findById(peerAgentId);
          if (!peerAgent || peerAgent.workspaceId !== context.run.workspaceId) {
            throw new Error(`Agent ${peerAgentId} not found in this workspace.`);
          }
          let runId = typeof input.runId === "string" ? input.runId : null;
          if (!runId) {
            const latestRuns = await repositories.runs.listByAgent(peerAgentId);
            runId = latestRuns[0]?.id ?? null;
          }
          if (!runId) {
            return { status: "completed", output: { agentId: peerAgentId, agentTitle: peerAgent.title, runId: null, entries: [], artifacts: [] } };
          }
          const lastN = typeof input.lastN === "number" ? Math.min(Math.max(1, input.lastN), 200) : 50;
          const [entries, artifacts] = await Promise.all([
            repositories.transcript.listByRunLimited(runId, lastN),
            repositories.artifacts.listByRun(runId),
          ]);
          return {
            status: "completed",
            output: {
              agentId: peerAgentId,
              agentTitle: peerAgent.title,
              runId,
              entries: entries.map((e) => ({ seq: e.seq, type: e.entryType, content: e.content.slice(0, 4096), createdAt: e.createdAt })),
              artifacts: artifacts.map((a) => ({ id: a.id, kind: a.kind, uri: a.uri })),
            },
          };
        }
        case "send_agent_message": {
          const toAgentId = typeof input.toAgentId === "string" ? input.toAgentId : "";
          if (!toAgentId) throw new Error("send_agent_message requires toAgentId.");
          if (toAgentId === context.run.agentId) throw new Error("Cannot send a message to yourself.");
          const subject = (typeof input.subject === "string" ? input.subject : "").slice(0, 140);
          const content = typeof input.content === "string" ? input.content : "";
          if (!subject) throw new Error("send_agent_message requires a non-empty subject.");
          const sameWorkspace = await repositories.messages.verifySameWorkspace(context.run.agentId, toAgentId);
          if (!sameWorkspace) throw new Error(`Agent ${toAgentId} is not in the same workspace.`);
          const now = new Date().toISOString();
          const message = await repositories.messages.send({
            id: createId("msg"),
            workspaceId: context.run.workspaceId,
            fromAgentId: context.run.agentId,
            toAgentId,
            subject,
            content,
            createdAt: now,
          });
          return {
            status: "completed",
            output: { messageId: message.id, toAgentId, subject, sentAt: message.createdAt },
          };
        }
        case "mark_message_read": {
          const messageId = typeof input.messageId === "string" ? input.messageId : "";
          if (!messageId) throw new Error("mark_message_read requires messageId.");
          const updated = await repositories.messages.markRead(messageId, context.run.agentId);
          if (!updated) {
            return { status: "completed", output: { messageId, error: "Message not found or not addressed to this agent." } };
          }
          return {
            status: "completed",
            output: { messageId: updated.id, readAt: updated.readAt },
          };
        }
        case "update_shared_context": {
          const key = (typeof input.key === "string" ? input.key : "").slice(0, 128);
          if (!key) throw new Error("update_shared_context requires a non-empty key.");
          const value = typeof input.value === "string" ? input.value : String(input.value ?? "");
          const updated = await repositories.workspaces.updateSharedContextKey(context.run.workspaceId, key, value);
          const totalKeys = updated ? Object.keys(updated.sharedContextKv).length : 0;
          return {
            status: "completed",
            output: { key, value, totalKeys, updatedAt: updated?.updatedAt ?? new Date().toISOString() },
          };
        }
        default:
          logger.warn(`unknown tool requested: ${call.toolName}`);
          throw new Error(`Unknown tool requested: ${call.toolName}`);
      }
    },
  };
}
