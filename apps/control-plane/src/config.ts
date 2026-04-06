import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

function parseBoolean(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return value;
}

const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  host: z.string().min(1).default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(7711),
  storageDir: z.string().min(1).optional(),
  databasePath: z.string().min(1).optional(),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  autoMigrate: z.preprocess(parseBoolean, z.boolean().default(true)),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  storageDir: string;
  databasePath: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  autoMigrate: boolean;
}

function getRepoRoot(): string {
  return resolve(process.env.ACC_REPO_ROOT ?? process.cwd());
}

function loadEnvironmentFiles(repoRoot: string): void {
  const envFiles = [
    resolve(repoRoot, ".env.local"),
    resolve(repoRoot, ".env"),
  ];

  for (const filePath of envFiles) {
    if (existsSync(filePath)) {
      loadDotEnv({ path: filePath, override: false });
    }
  }
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRoot = getRepoRoot();

  if (env === process.env) {
    loadEnvironmentFiles(repoRoot);
  }

  const rawConfig = {
    nodeEnv: env.NODE_ENV,
    host: env.ACC_HOST ?? env.HOST,
    port: env.ACC_PORT ?? env.PORT,
    storageDir: env.ACC_STORAGE_DIR,
    databasePath: env.ACC_DATABASE_PATH,
    logLevel: env.ACC_LOG_LEVEL ?? env.LOG_LEVEL,
    autoMigrate: env.ACC_AUTO_MIGRATE ?? env.AUTO_MIGRATE,
  };

  const parsed = configSchema.safeParse(rawConfig);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");

    throw new Error(`Invalid control plane configuration: ${details}`);
  }

  const storageDir = parsed.data.storageDir ?? resolve(repoRoot, ".acc-data");
  const databasePath = parsed.data.databasePath ?? resolve(storageDir, "control-plane.sqlite");

  return {
    nodeEnv: parsed.data.nodeEnv,
    host: parsed.data.host,
    port: parsed.data.port,
    storageDir,
    databasePath,
    logLevel: parsed.data.logLevel,
    autoMigrate: parsed.data.autoMigrate,
  };
}
