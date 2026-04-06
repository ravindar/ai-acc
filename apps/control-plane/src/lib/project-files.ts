import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

import type { ProjectFileCandidateRecord } from "@acc/shared-types";

const MAX_DISCOVERED_SOURCE_FILES = 36;
const MAX_IMPORT_FILE_BYTES = 24_000;
const ROOT_FILE_PRIORITY = [
  "README.md",
  "README",
  "AGENTS.md",
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  ".env.example",
] as const;
const SOURCE_ROOTS = ["src", "app", "apps", "packages", "services"] as const;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "target",
  ".acc-data",
]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  ".toml",
  ".rs",
  ".go",
  ".py",
  ".sh",
]);

function categorizePath(path: string): ProjectFileCandidateRecord["category"] {
  const normalized = path.toLowerCase();

  if (normalized.includes("readme") || normalized.endsWith(".md") || normalized.endsWith(".mdx")) {
    return "doc";
  }

  if (
    normalized.endsWith("package.json") ||
    normalized.endsWith("pnpm-workspace.yaml") ||
    normalized.endsWith("turbo.json")
  ) {
    return "manifest";
  }

  if (
    normalized.endsWith("tsconfig.json") ||
    normalized.endsWith(".yml") ||
    normalized.endsWith(".yaml") ||
    normalized.endsWith(".toml") ||
    normalized.endsWith(".json")
  ) {
    return "config";
  }

  return "source";
}

async function assertDirectory(projectRoot: string): Promise<string> {
  const resolvedRoot = resolve(projectRoot.trim());
  const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
  const rootStat = await stat(realRoot).catch(() => null);

  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`Project root ${projectRoot} was not found or is not a directory.`);
  }

  return realRoot;
}

function ensureInsideRoot(projectRoot: string, relativePath: string): string {
  const targetPath = resolve(projectRoot, relativePath);
  const nextRelative = relative(projectRoot, targetPath);

  if (nextRelative.startsWith("..") || nextRelative.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`File ${relativePath} is outside the configured project root.`);
  }

  return targetPath;
}

async function walkSourceTree(
  projectRoot: string,
  sourceRoot: string,
  candidates: ProjectFileCandidateRecord[],
  visited = new Set<string>(),
): Promise<void> {
  const absoluteRoot = join(projectRoot, sourceRoot);
  const rootStat = await stat(absoluteRoot).catch(() => null);

  if (!rootStat?.isDirectory()) {
    return;
  }

  async function visit(currentDirectory: string, depth: number): Promise<void> {
    if (candidates.length >= MAX_DISCOVERED_SOURCE_FILES) {
      return;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (candidates.length >= MAX_DISCOVERED_SOURCE_FILES) {
        return;
      }

      const absolutePath = join(currentDirectory, entry.name);
      const relativePath = relative(projectRoot, absolutePath);

      if (entry.isDirectory()) {
        if (depth >= 3 || SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }

        await visit(absolutePath, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }

      if (visited.has(relativePath)) {
        continue;
      }

      const entryStat = await stat(absolutePath).catch(() => null);
      visited.add(relativePath);
      candidates.push({
        path: relativePath,
        sizeBytes: entryStat?.size ?? 0,
        category: categorizePath(relativePath),
      });
    }
  }

  await visit(absoluteRoot, 0);
}

export async function resolveProjectRoot(projectRoot: string): Promise<string> {
  return assertDirectory(projectRoot);
}

export async function listProjectFileCandidates(projectRoot: string): Promise<ProjectFileCandidateRecord[]> {
  const root = await assertDirectory(projectRoot);
  const candidates: ProjectFileCandidateRecord[] = [];
  const visited = new Set<string>();

  for (const filename of ROOT_FILE_PRIORITY) {
    const absolutePath = join(root, filename);
    const entryStat = await stat(absolutePath).catch(() => null);

    if (!entryStat?.isFile()) {
      continue;
    }

    visited.add(filename);
    candidates.push({
      path: filename,
      sizeBytes: entryStat.size,
      category: categorizePath(filename),
    });
  }

  for (const directory of SOURCE_ROOTS) {
    await walkSourceTree(root, directory, candidates, visited);
  }

  return candidates;
}

export async function importProjectFiles(
  projectRoot: string,
  relativePaths: string[],
): Promise<Array<{ path: string; content: string }>> {
  const root = await assertDirectory(projectRoot);
  const uniquePaths = Array.from(new Set(relativePaths.map((path) => path.trim()).filter(Boolean)));
  const imported: Array<{ path: string; content: string }> = [];

  for (const relativePath of uniquePaths) {
    const absolutePath = ensureInsideRoot(root, relativePath);
    const entryStat = await stat(absolutePath).catch(() => null);

    if (!entryStat?.isFile()) {
      throw new Error(`File ${relativePath} was not found in the configured project root.`);
    }

    const rawContent = await readFile(absolutePath, "utf8");

    if (rawContent.includes("\u0000")) {
      throw new Error(`File ${relativePath} looks binary and cannot be imported into shared context.`);
    }

    const content =
      Buffer.byteLength(rawContent, "utf8") > MAX_IMPORT_FILE_BYTES
        ? `${rawContent.slice(0, MAX_IMPORT_FILE_BYTES)}\n\n[truncated after ${MAX_IMPORT_FILE_BYTES.toLocaleString()} bytes]`
        : rawContent;

    imported.push({
      path: relativePath,
      content,
    });
  }

  return imported;
}

export function formatImportedFiles(entries: Array<{ path: string; content: string }>): string {
  return entries
    .map(
      (entry) =>
        [`File: ${entry.path}`, "---", entry.content.trimEnd()].filter(Boolean).join("\n"),
    )
    .join("\n\n");
}
