#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const controlPlaneBundle = resolve(repoRoot, "apps/desktop/src-tauri/resources/control-plane/index.cjs");
const port = Number(process.env.ACC_SMOKE_PORT ?? "7731");

async function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function pollHealth(baseUrl, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }

    await wait(250);
  }

  throw new Error(`Control plane never became healthy on ${baseUrl}`);
}

async function jsonRequest(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers);

  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function createSmokeRepo(root) {
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "README.md"), "# Smoke repo\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "acc-smoke-repo",
        private: true,
        scripts: {
          build: "node -e \"console.log('build ok')\"",
          test: "node -e \"console.log('test ok')\"",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=ACC", "-c", "user.email=acc@example.com", "commit", "-q", "-m", "init"],
    { cwd: root },
  );
}

async function pollFor(baseUrl, fn, attempts = 40, delayMs = 250) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await fn();
    if (result) {
      return result;
    }
    await wait(delayMs);
  }
  throw new Error(`Condition timed out after ${attempts} attempts.`);
}

async function main() {
  const baseTemp = await mkdtemp(join(tmpdir(), "acc-production-alpha-"));
  const storageDir = join(baseTemp, "storage");
  const databasePath = join(storageDir, "control-plane.sqlite");
  const smokeRepo = join(baseTemp, "repo");
  const baseUrl = `http://127.0.0.1:${port}`;

  await createSmokeRepo(smokeRepo);

  const child = spawn(process.execPath, [controlPlaneBundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      ACC_HOST: "127.0.0.1",
      ACC_PORT: String(port),
      ACC_STORAGE_DIR: storageDir,
      ACC_DATABASE_PATH: databasePath,
      ACC_AUTO_MIGRATE: "true",
    },
    stdio: "inherit",
  });

  try {
    await pollHealth(baseUrl);

    const workspaceResponse = await jsonRequest(baseUrl, "/api/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Production Alpha Smoke",
        projectRoot: smokeRepo,
      }),
    });
    const workspace = workspaceResponse.workspace;

    const agentResponse = await jsonRequest(baseUrl, "/api/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: workspace.id,
        provider: "mock",
        model: "tool-smoke",
        title: "Smoke agent",
        role: "Implementer",
        task: "Inspect the repository, request a risky command approval, and leave a handoff.",
        cwd: smokeRepo,
      }),
    });
    const agent = agentResponse.agent;

    const worktreeResponse = await jsonRequest(baseUrl, `/api/v1/agents/${agent.id}/worktree/reset`, {
      method: "POST",
    });
    const worktree = worktreeResponse.worktree;

    if (worktree.status !== "READY") {
      throw new Error(`Expected worktree READY but got ${worktree.status}`);
    }

    const runResponse = await jsonRequest(baseUrl, `/api/v1/agents/${agent.id}/runs`, {
      method: "POST",
      body: JSON.stringify({
        title: "Smoke run",
        prompt: "Read the repo, request approval for one command, and then create a handoff.",
      }),
    });
    const run = runResponse.run;

    const approvalPayload = await pollFor(baseUrl, async () => {
      const approvalsResponse = await jsonRequest(baseUrl, `/api/v1/approvals?workspaceId=${workspace.id}`);
      if (Array.isArray(approvalsResponse.approvals) && approvalsResponse.approvals.length > 0) {
        return approvalsResponse.approvals;
      }
      return null;
    });
    const approval = approvalPayload[0];

    if (approval.status !== "PENDING") {
      throw new Error(`Expected approval to be PENDING but got ${approval.status}`);
    }

    await jsonRequest(baseUrl, `/api/v1/approvals/${approval.id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        decisionMessage: "Approved by smoke test.",
      }),
    });

    const settledRun = await pollFor(baseUrl, async () => {
      const runs = await jsonRequest(baseUrl, `/api/v1/agents/${agent.id}/runs`);
      const current = runs.runs[0];
      if (["COMPLETED", "ERROR", "WAITING_APPROVAL", "STOPPED"].includes(current.state)) {
        return current;
      }
      return null;
    }, 60, 250);

    const transcript = await jsonRequest(baseUrl, `/api/v1/runs/${run.id}/transcript`);
    const toolCalls = await jsonRequest(baseUrl, `/api/v1/runs/${run.id}/tool-calls`);
    const inbox = await jsonRequest(baseUrl, `/api/v1/workspaces/${workspace.id}/inbox`);

    if (settledRun.state !== "COMPLETED") {
      throw new Error(`Expected completed run after approval but got ${settledRun.state}`);
    }

    if (!Array.isArray(transcript.transcript) || transcript.transcript.length < 4) {
      throw new Error("Expected persisted transcript entries for the run.");
    }

    if (!Array.isArray(toolCalls.toolCalls) || toolCalls.toolCalls.length < 2) {
      throw new Error("Expected at least two tool calls (approved command + handoff).");
    }

    if (!Array.isArray(inbox.inbox) || inbox.inbox.length < 1) {
      throw new Error("Expected at least one handoff item in the inbox.");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          workspaceId: workspace.id,
          agentId: agent.id,
          runId: settledRun.id,
          runState: settledRun.state,
          worktreePath: worktree.path,
          transcriptEntries: transcript.transcript.length,
          approvals: 1,
          handoffs: inbox.inbox.length,
          toolCalls: toolCalls.toolCalls.map((call) => ({
            toolName: call.toolName,
            status: call.status,
          })),
          smokeRepo,
        },
        null,
        2,
      ),
    );
  } finally {
    child.kill("SIGTERM");
    await wait(500);
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    await rm(baseTemp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
