import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";
import {
  getSqliteBusyWorstCaseLatencyMs,
  SQLITE_LOCK_PRESSURE_BEGIN_THRESHOLD_MS,
  SQLITE_BUSY_TIMEOUT_MS,
} from "../../backend/sqliteBusyRetry";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe.serial("AppDatabase SQLite lock pressure", () => {
  let applicationPaths: ApplicationPaths;
  let database: AppDatabase;
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-db-lock-pressure");
    applicationPaths = {
      configFilePath: path.join(rootDir, "config.json"),
      databasePath: path.join(rootDir, "local-llm-gui.sqlite"),
      mediaDir: path.join(rootDir, "media"),
      staticOutDir: path.join(rootDir, "out"),
      tempDir: path.join(rootDir, "temp"),
      toolsDir: path.join(rootDir, "tools"),
      userDataDir: rootDir,
      workspaceRoot: rootDir,
    };

    await Promise.all([
      mkdir(applicationPaths.mediaDir, { recursive: true }),
      mkdir(applicationPaths.tempDir, { recursive: true }),
      mkdir(applicationPaths.toolsDir, { recursive: true }),
    ]);

    database = new AppDatabase(applicationPaths);
  });

  afterEach(async () => {
    database.close();
    await removeBackendTestScratchDir(rootDir);
  });

  test("surfaces lock pressure and keeps write latency bounded under real SQLite contention", async () => {
    const chat = await database.createChat("Lock pressure");
    const lockHandle = new Database(applicationPaths.databasePath);
    let lockHandleClosed = false;
    const releaseDelayMs = SQLITE_BUSY_TIMEOUT_MS + 350;
    const workerScriptPath = fileURLToPath(
      new URL("./fixtures/sqliteBusyContentionWorker.ts", import.meta.url),
    );
    let workerProcess: ReturnType<typeof spawn> | null = null;

    lockHandle.exec(`PRAGMA busy_timeout = ${String(SQLITE_BUSY_TIMEOUT_MS)};`);
    lockHandle.exec("BEGIN IMMEDIATE");

    const releaseHandle = setTimeout(() => {
      lockHandle.exec("COMMIT");
      lockHandle.close(true);
      lockHandleClosed = true;
    }, releaseDelayMs);

    try {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const spawnedWorker = spawn(process.execPath, [workerScriptPath, rootDir, chat.id], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      workerProcess = spawnedWorker;
      spawnedWorker.stdout.on("data", (chunk: Buffer | string) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      spawnedWorker.stderr.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        spawnedWorker.once("exit", (code) => {
          resolve(code);
        });
      });
      const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();

      expect(exitCode).toBe(0);
      expect(stderrOutput).toBe("");

      const payload = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as {
        blockedBeginEvents: Array<{ attempt: number; elapsedMs: number; maxRetries: number }>;
        elapsedMs: number;
        messageId: string;
        retryEvents: Array<{ attempt: number; delayMs: number; maxRetries: number }>;
      };
      const observedBlockedElapsedMs = Math.max(
        0,
        ...payload.blockedBeginEvents.map((event) => event.elapsedMs),
      );

      expect(payload.blockedBeginEvents.length + payload.retryEvents.length).toBeGreaterThan(0);
      expect(observedBlockedElapsedMs).toBeGreaterThanOrEqual(
        SQLITE_LOCK_PRESSURE_BEGIN_THRESHOLD_MS,
      );
      expect(payload.elapsedMs).toBeLessThanOrEqual(getSqliteBusyWorstCaseLatencyMs() + 750);

      const persistedChat = database.getChat(chat.id);

      expect(persistedChat?.messages.some((message) => message.id === payload.messageId)).toBe(
        true,
      );
    } finally {
      clearTimeout(releaseHandle);

      if (!lockHandleClosed) {
        if (lockHandle.inTransaction) {
          lockHandle.exec("ROLLBACK");
        }

        lockHandle.close(true);
        lockHandleClosed = true;
      }

      workerProcess?.kill();
    }
  }, 20_000);
});
