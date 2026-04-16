import path from "node:path";
import { AppDatabase } from "../../../backend/db";
import type { ApplicationPaths } from "../../../backend/paths";

async function main(): Promise<void> {
  const rootDir = process.argv[2];
  const chatId = process.argv[3];

  if (!rootDir || !chatId) {
    throw new Error("Expected rootDir and chatId arguments.");
  }

  const applicationPaths: ApplicationPaths = {
    configFilePath: path.join(rootDir, "config.json"),
    databasePath: path.join(rootDir, "local-llm-gui.sqlite"),
    mediaDir: path.join(rootDir, "media"),
    staticOutDir: path.join(rootDir, "out"),
    tempDir: path.join(rootDir, "temp"),
    toolsDir: path.join(rootDir, "tools"),
    userDataDir: rootDir,
    workspaceRoot: rootDir,
  };
  const blockedBeginEvents: Array<{ attempt: number; elapsedMs: number; maxRetries: number }> = [];
  const retryEvents: Array<{ attempt: number; delayMs: number; maxRetries: number }> = [];
  const database = new AppDatabase(applicationPaths, {
    onSqliteBeginBlocked: (event) => {
      blockedBeginEvents.push(event);
    },
    onSqliteBusyRetry: (event) => {
      retryEvents.push(event);
    },
  });
  const startedAt = Date.now();

  try {
    const message = database.appendMessage(chatId, "user", "contended write");

    process.stdout.write(
      JSON.stringify({
        blockedBeginEvents,
        elapsedMs: Date.now() - startedAt,
        messageId: message.id,
        retryEvents,
      }),
    );
  } finally {
    database.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);

  process.stderr.write(message);
  process.exit(1);
});
