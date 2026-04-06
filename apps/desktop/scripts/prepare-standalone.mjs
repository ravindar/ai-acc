import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const repoRoot = resolve(desktopDir, '..', '..');
const resourcesDir = resolve(desktopDir, 'src-tauri', 'resources');
const controlPlaneDir = resolve(resourcesDir, 'control-plane');
const binDir = resolve(resourcesDir, 'bin');
const bundledEntry = resolve(controlPlaneDir, 'index.cjs');
const bundledNode = resolve(binDir, 'acc-node');
const esbuildBin = resolve(repoRoot, 'node_modules', '.pnpm', 'node_modules', 'esbuild', 'bin', 'esbuild');
const controlPlaneEntry = resolve(repoRoot, 'apps', 'control-plane', 'src', 'index.ts');
const bundleTarget = process.env.ACC_STANDALONE_TARGET || process.env.TARGET || '';

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      ...options,
    });

    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function capture(command, args, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }

      rejectPromise(new Error(`${command} exited with code ${code ?? 'unknown'}: ${stderr.trim()}`));
    });
  });
}

async function getBinaryArchitectures(binaryPath) {
  if (process.platform !== 'darwin') {
    return [];
  }

  try {
    const stdout = await capture('lipo', ['-archs', binaryPath]);
    return stdout.split(/\s+/).filter(Boolean);
  } catch {
    const stdout = await capture('file', [binaryPath]);
    return ['arm64', 'x86_64'].filter((arch) => stdout.includes(arch));
  }
}

async function assertBundledNodeSupportsTarget(binaryPath, target) {
  if (process.platform !== 'darwin' || !target) {
    return;
  }

  const archs = await getBinaryArchitectures(binaryPath);

  if (target === 'universal-apple-darwin') {
    if (!archs.includes('arm64') || !archs.includes('x86_64')) {
      throw new Error(
        `Standalone Node runtime at ${binaryPath} must be universal for ${target}. Found architectures: ${archs.join(', ') || 'unknown'}.`,
      );
    }
    return;
  }

  if (target === 'aarch64-apple-darwin' && !archs.includes('arm64')) {
    throw new Error(`Standalone Node runtime at ${binaryPath} does not include arm64 support.`);
  }

  if (target === 'x86_64-apple-darwin' && !archs.includes('x86_64')) {
    throw new Error(`Standalone Node runtime at ${binaryPath} does not include x86_64 support.`);
  }
}

async function resolveBundledNodeSource(target) {
  const candidates = [];

  if (process.env.ACC_STANDALONE_NODE_PATH) {
    candidates.push(process.env.ACC_STANDALONE_NODE_PATH);
  }

  try {
    const shellRuntimeNodePath = await capture('/bin/sh', ['-lc', 'node -p "process.execPath"']);
    if (shellRuntimeNodePath) {
      candidates.push(shellRuntimeNodePath);
    }
  } catch {
    // Fall back to the current process runtime when a shell lookup is unavailable.
  }

  candidates.push(process.execPath);

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  let lastError;

  for (const candidate of uniqueCandidates) {
    try {
      await assertBundledNodeSupportsTarget(candidate, target);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('Unable to resolve a standalone Node runtime for the current build target.');
}

async function main() {
  await rm(resourcesDir, { recursive: true, force: true });
  await mkdir(controlPlaneDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  const bundledNodeSource = await resolveBundledNodeSource(bundleTarget);

  await run(process.execPath, [
    esbuildBin,
    controlPlaneEntry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node24',
    `--outfile=${bundledEntry}`,
    '--legal-comments=none',
    '--packages=bundle',
    '--tsconfig=tsconfig.base.json',
  ]);

  await copyFile(bundledNodeSource, bundledNode);
  await chmod(bundledNode, 0o755);
  await assertBundledNodeSupportsTarget(bundledNode, bundleTarget);

  console.log(`Prepared standalone control-plane bundle at ${bundledEntry}`);
  console.log(`Bundled Node runtime from ${bundledNodeSource}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
