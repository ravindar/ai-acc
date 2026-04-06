import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { AgentSessionRecord, WorktreeRecord, WorkspaceRecord } from "@acc/shared-types";

import type { AppConfig } from "../config.js";
import { createId } from "./ids.js";
import type { Repositories } from "./repositories.js";

const execFileAsync = promisify(execFile);

type LoggerLike = Pick<Console, "error" | "info" | "warn">;

type ExecResult = {
  stdout: string;
  stderr: string;
};

export type GitWorkspaceInspection = {
  enabled: boolean;
  repoRoot?: string;
  reason?: string;
};

type RunGitOptions = {
  cwd: string;
  allowFailure?: boolean;
};

async function runGit(args: string[], options: RunGitOptions): Promise<ExecResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (options.allowFailure) {
      const execError = error as Error & { stdout?: string; stderr?: string };
      return {
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? execError.message,
      };
    }

    throw error;
  }
}

function worktreeBranch(workspaceId: string, agentId: string): string {
  return `acc/${workspaceId}/${agentId}`;
}

export interface WorktreeManager {
  inspectProjectRoot(projectRoot: string): Promise<GitWorkspaceInspection>;
  ensureAgentWorktree(agent: AgentSessionRecord, workspace: WorkspaceRecord): Promise<WorktreeRecord>;
  resetAgentWorktree(agent: AgentSessionRecord, workspace: WorkspaceRecord): Promise<WorktreeRecord>;
}

export function createWorktreeManager(
  config: AppConfig,
  repositories: Repositories,
  logger: LoggerLike = console,
): WorktreeManager {
  const worktreeRoot = resolve(config.storageDir, "worktrees");

  async function inspectProjectRoot(projectRoot: string): Promise<GitWorkspaceInspection> {
    const normalizedRoot = projectRoot.trim();

    if (!normalizedRoot) {
      return {
        enabled: false,
        reason: "Workspace project root is empty.",
      };
    }

    if (!existsSync(normalizedRoot)) {
      return {
        enabled: false,
        reason: `Workspace project root does not exist: ${normalizedRoot}`,
      };
    }

    const result = await runGit(["rev-parse", "--show-toplevel"], {
      cwd: normalizedRoot,
      allowFailure: true,
    });
    const repoRoot = result.stdout.trim();

    if (!repoRoot) {
      return {
        enabled: false,
        reason: "Workspace project root is not a Git repository.",
      };
    }

    return {
      enabled: true,
      repoRoot,
    };
  }

  function buildWorktreePath(workspaceId: string, agentId: string): string {
    return resolve(worktreeRoot, workspaceId, agentId);
  }

  async function upsertRecord(
    agent: AgentSessionRecord,
    repoRoot: string,
    path: string,
    status: WorktreeRecord["status"],
  ): Promise<WorktreeRecord> {
    const now = new Date().toISOString();
    const existing = await repositories.worktrees.findByAgentId(agent.id);

    return repositories.worktrees.upsert({
      id: existing?.id ?? createId("wt"),
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      repoRoot,
      branch: worktreeBranch(agent.workspaceId, agent.id),
      path,
      baseRef: "HEAD",
      status,
      lastValidatedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async function removeExistingWorktree(repoRoot: string, path: string): Promise<void> {
    await runGit(["worktree", "remove", "--force", path], {
      cwd: repoRoot,
      allowFailure: true,
    });
    await rm(path, { recursive: true, force: true });
    await runGit(["worktree", "prune"], {
      cwd: repoRoot,
      allowFailure: true,
    });
  }

  async function createFreshWorktree(
    agent: AgentSessionRecord,
    repoRoot: string,
    path: string,
  ): Promise<WorktreeRecord> {
    const branch = worktreeBranch(agent.workspaceId, agent.id);

    await mkdir(resolve(path, ".."), { recursive: true });
    await removeExistingWorktree(repoRoot, path);
    await runGit(["branch", "-f", branch, "HEAD"], {
      cwd: repoRoot,
    });
    await runGit(["worktree", "add", "--force", path, branch], {
      cwd: repoRoot,
    });

    return upsertRecord(agent, repoRoot, path, "READY");
  }

  return {
    inspectProjectRoot,

    async ensureAgentWorktree(agent, workspace) {
      const inspection = await inspectProjectRoot(workspace.projectRoot);

      if (!inspection.enabled || !inspection.repoRoot) {
        throw new Error(inspection.reason ?? "Workspace is not configured for Git worktrees.");
      }

      const path = buildWorktreePath(workspace.id, agent.id);
      const existing = await repositories.worktrees.findByAgentId(agent.id);

      if (existing?.path && existsSync(existing.path)) {
        try {
          const validation = await runGit(["rev-parse", "--show-toplevel"], {
            cwd: existing.path,
          });

          if (validation.stdout.trim()) {
            return upsertRecord(agent, inspection.repoRoot, existing.path, "READY");
          }
        } catch (error) {
          logger.warn(`worktree validation failed for ${agent.id}: ${String(error)}`);
          await upsertRecord(agent, inspection.repoRoot, existing.path, "ERROR");
        }
      }

      return createFreshWorktree(agent, inspection.repoRoot, path);
    },

    async resetAgentWorktree(agent, workspace) {
      const inspection = await inspectProjectRoot(workspace.projectRoot);

      if (!inspection.enabled || !inspection.repoRoot) {
        throw new Error(inspection.reason ?? "Workspace is not configured for Git worktrees.");
      }

      const current = await repositories.worktrees.findByAgentId(agent.id);
      const path = current?.path ?? buildWorktreePath(workspace.id, agent.id);
      await removeExistingWorktree(inspection.repoRoot, path);
      return createFreshWorktree(agent, inspection.repoRoot, path);
    },
  };
}
