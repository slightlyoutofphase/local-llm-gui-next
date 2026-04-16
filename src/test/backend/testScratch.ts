import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";

const BACKEND_TEST_SCRATCH_ROOT = path.resolve(import.meta.dir, "../../../.tmp-tests/backend");
const REMOVE_RETRYABLE_ERROR_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
const REMOVE_MAX_ATTEMPTS = 8;
const REMOVE_RETRY_DELAY_MS = 100;

export async function createBackendTestScratchDir(prefix: string): Promise<string> {
  await mkdir(BACKEND_TEST_SCRATCH_ROOT, { recursive: true });

  return mkdtemp(path.join(BACKEND_TEST_SCRATCH_ROOT, normalizePrefix(prefix)));
}

export async function removeBackendTestScratchDir(directoryPath: string): Promise<void> {
  if (directoryPath.trim().length === 0) {
    return;
  }

  for (let attemptIndex = 0; attemptIndex < REMOVE_MAX_ATTEMPTS; attemptIndex += 1) {
    try {
      await rm(directoryPath, { force: true, recursive: true });
      await removeScratchRootIfEmpty();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (
        !code ||
        !REMOVE_RETRYABLE_ERROR_CODES.has(code) ||
        attemptIndex === REMOVE_MAX_ATTEMPTS - 1
      ) {
        throw error;
      }

      await delay(REMOVE_RETRY_DELAY_MS * (attemptIndex + 1));
    }
  }
}

export async function stopBackendTestProcess(childProcess: ChildProcess): Promise<void> {
  if (childProcess.exitCode !== null) {
    return;
  }

  if (process.platform === "win32" && childProcess.pid) {
    childProcess.kill();

    try {
      await waitForProcessExit(childProcess, 5_000);
      return;
    } catch {
      await Bun.spawn(["taskkill", "/T", "/F", "/PID", String(childProcess.pid)], {
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      }).exited;
      await waitForProcessExit(childProcess, 5_000).catch(() => undefined);
      return;
    }
  }

  childProcess.kill();

  try {
    await waitForProcessExit(childProcess, 10_000);
  } catch {
    childProcess.kill("SIGKILL");
    await once(childProcess, "exit");
  }
}

function normalizePrefix(prefix: string): string {
  const sanitizedPrefix = prefix
    .trim()
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitizedPrefix.length > 0 ? `${sanitizedPrefix}-` : "backend-test-";
}

async function removeScratchRootIfEmpty(): Promise<void> {
  try {
    const remainingEntries = await readdir(BACKEND_TEST_SCRATCH_ROOT);

    if (remainingEntries.length > 0) {
      return;
    }

    await rmdir(BACKEND_TEST_SCRATCH_ROOT);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") {
      throw error;
    }
  }
}

async function waitForProcessExit(childProcess: ChildProcess, timeoutMs: number): Promise<void> {
  await Promise.race([
    once(childProcess, "exit").then(() => undefined),
    delay(timeoutMs).then(() => {
      throw new Error("Timed out waiting for the backend child process to exit.");
    }),
  ]);
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
