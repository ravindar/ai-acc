#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const appBundle = process.argv[2] || resolve(repoRoot, "apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app");
const binaryPath = resolve(appBundle, "Contents/MacOS/acc-desktop");
const healthUrl = "http://127.0.0.1:7711/health";
const baseUrl = "http://127.0.0.1:7711";

async function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function pollHealth(attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await wait(500);
  }
  throw new Error(`Packaged app never exposed ${healthUrl}`);
}

async function jsonRequest(path, init = {}) {
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

async function pollFor(fn, attempts = 50, delayMs = 300) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await fn();
    if (result) {
      return result;
    }
    await wait(delayMs);
  }
  throw new Error(`Condition timed out after ${attempts} attempts.`);
}

async function createSmokeRepo(root) {
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "README.md"), "# Packaged smoke repo\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "acc-packaged-smoke",
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

async function ensurePortAvailable() {
  try {
    const response = await fetch(healthUrl);
    if (response.ok) {
      throw new Error("Port 7711 is already serving a control plane. Stop the running ACC app before packaged smoke testing.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already serving")) {
      throw error;
    }
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Packaged app smoke testing is only supported on macOS.");
  }

  if (!existsSync(binaryPath)) {
    throw new Error(`Missing packaged app binary: ${binaryPath}`);
  }

  await ensurePortAvailable();

  const baseTemp = await mkdtemp(join(tmpdir(), "acc-packaged-alpha-"));
  const fakeHome = join(baseTemp, "home");
  const smokeRepo = join(baseTemp, "repo");
  await mkdir(fakeHome, { recursive: true });
  await createSmokeRepo(smokeRepo);

  const child = spawn(binaryPath, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: fakeHome,
      RUST_BACKTRACE: process.env.RUST_BACKTRACE || "1",
    },
    stdio: "ignore",
  });

  try {
    await pollHealth();

    const workspaceResponse = await jsonRequest("/api/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Packaged Alpha Smoke",
        projectRoot: smokeRepo,
      }),
    });
    const workspace = workspaceResponse.workspace;

    const agentResponse = await jsonRequest("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: workspace.id,
        provider: "mock",
        model: "tool-smoke",
        title: "Packaged smoke agent",
        role: "Verifier",
        task: "Request approval for a command, then create a handoff.",
        cwd: smokeRepo,
      }),
    });
    const agent = agentResponse.agent;

    const worktreeResponse = await jsonRequest(`/api/v1/agents/${agent.id}/worktree/reset`, {
      method: "POST",
    });
    const worktree = worktreeResponse.worktree;

    const runResponse = await jsonRequest(`/api/v1/agents/${agent.id}/runs`, {
      method: "POST",
      body: JSON.stringify({
        title: "Packaged smoke run",
        prompt: "Use one approval-gated command and then leave a structured handoff.",
      }),
    });
    const run = runResponse.run;

    const approval = await pollFor(async () => {
      const response = await jsonRequest(`/api/v1/approvals?workspaceId=${workspace.id}`);
      return Array.isArray(response.approvals) && response.approvals[0] ? response.approvals[0] : null;
    });

    await jsonRequest(`/api/v1/approvals/${approval.id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        decisionMessage: "Approved by packaged smoke.",
      }),
    });

    const settledRun = await pollFor(async () => {
      const response = await jsonRequest(`/api/v1/agents/${agent.id}/runs`);
      const current = response.runs[0];
      return current && ["COMPLETED", "ERROR", "WAITING_APPROVAL", "STOPPED"].includes(current.state) ? current : null;
    }, 60, 300);

    const transcript = await jsonRequest(`/api/v1/runs/${run.id}/transcript`);
    const inbox = await jsonRequest(`/api/v1/workspaces/${workspace.id}/inbox`);

    if (settledRun.state !== "COMPLETED") {
      throw new Error(`Expected packaged run to complete but got ${settledRun.state}`);
    }

    if (!Array.isArray(transcript.transcript) || transcript.transcript.length < 4) {
      throw new Error("Expected transcript entries from packaged app run.");
    }

    if (!Array.isArray(inbox.inbox) || inbox.inbox.length < 1) {
      throw new Error("Expected handoff items from packaged app run.");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          appBundle,
          workspaceId: workspace.id,
          agentId: agent.id,
          runId: settledRun.id,
          runState: settledRun.state,
          worktreePath: worktree.path,
          transcriptEntries: transcript.transcript.length,
          handoffs: inbox.inbox.length,
        },
        null,
        2,
      ),
    );
  } finally {
    child.kill("SIGTERM");
    await wait(1000);
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
