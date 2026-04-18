import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";
import {
  createBackendTestScratchDir,
  removeBackendTestScratchDir,
  stopBackendTestProcess,
} from "./testScratch";

describe("backend chat search and export", () => {
  let serverProcess: ChildProcess | null = null;
  let userDataDir = "";

  afterEach(async () => {
    if (serverProcess) {
      await stopBackendTestProcess(serverProcess);
      serverProcess = null;
    }

    if (userDataDir) {
      await removeBackendTestScratchDir(userDataDir);
      userDataDir = "";
    }
  });

  test(
    "searches persisted transcript content instead of titles only",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-search-export");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const matchingChatId = await createChat(backendServer.baseUrl, "Unrelated title");
      const otherChatId = await createChat(backendServer.baseUrl, "Completely different");

      await appendMessage(
        backendServer.baseUrl,
        matchingChatId,
        "user",
        "Trace the nebula cluster.",
      );
      await appendMessage(backendServer.baseUrl, otherChatId, "user", "Summarize the weather.");

      const response = await fetch(`${backendServer.baseUrl}/api/chats?search=nebula`);
      const payload = (await response.json()) as {
        chats: Array<{ id: string; title: string }>;
      };

      expect(response.status).toBe(200);
      expect(payload.chats).toHaveLength(1);
      expect(payload.chats[0]?.id).toBe(matchingChatId);
    },
    { timeout: 30_000 },
  );

  test(
    "ignores FTS operators in user-entered chat searches instead of failing the request",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-search-export");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const matchingChatId = await createChat(backendServer.baseUrl, "Operator search");

      await appendMessage(
        backendServer.baseUrl,
        matchingChatId,
        "user",
        "Trace the nebula cluster.",
      );

      const response = await fetch(
        `${backendServer.baseUrl}/api/chats?search=${encodeURIComponent("nebula OR [")}`,
      );
      const payload = (await response.json()) as {
        chats: Array<{ id: string; title: string }>;
      };

      expect(response.status).toBe(200);
      expect(payload.chats).toHaveLength(1);
      expect(payload.chats[0]?.id).toBe(matchingChatId);
    },
    { timeout: 30_000 },
  );

  test(
    "returns no matches for punctuation-only chat searches instead of falling back to the full list",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-search-export");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      await createChat(backendServer.baseUrl, "Operator search");

      const response = await fetch(
        `${backendServer.baseUrl}/api/chats?search=${encodeURIComponent("++[[--")}`,
      );
      const payload = (await response.json()) as {
        chats: Array<{ id: string; title: string }>;
      };

      expect(response.status).toBe(200);
      expect(payload.chats).toHaveLength(0);
    },
    { timeout: 30_000 },
  );

  test(
    "stops returning stale titles and transcript content after rename and edit truncation",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-search-export");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Original title");
      const userMessageId = await appendMessage(
        backendServer.baseUrl,
        chatId,
        "user",
        "Leaked search phrase.",
      );

      await appendMessage(backendServer.baseUrl, chatId, "assistant", "First answer.");
      await renameChat(backendServer.baseUrl, chatId, "Renamed title");
      await editMessage(backendServer.baseUrl, chatId, userMessageId, "Replacement prompt.");

      const staleTitleResponse = await fetch(
        `${backendServer.baseUrl}/api/chats?search=${encodeURIComponent("Original")}`,
      );
      const staleTitlePayload = (await staleTitleResponse.json()) as {
        chats: Array<{ id: string }>;
      };
      const staleContentResponse = await fetch(
        `${backendServer.baseUrl}/api/chats?search=${encodeURIComponent("Leaked search phrase")}`,
      );
      const staleContentPayload = (await staleContentResponse.json()) as {
        chats: Array<{ id: string }>;
      };
      const replacementResponse = await fetch(
        `${backendServer.baseUrl}/api/chats?search=${encodeURIComponent("Replacement prompt")}`,
      );
      const replacementPayload = (await replacementResponse.json()) as {
        chats: Array<{ id: string }>;
      };

      expect(staleTitleResponse.status).toBe(200);
      expect(staleTitlePayload.chats).toHaveLength(0);
      expect(staleContentResponse.status).toBe(200);
      expect(staleContentPayload.chats).toHaveLength(0);
      expect(replacementResponse.status).toBe(200);
      expect(replacementPayload.chats).toHaveLength(1);
      expect(replacementPayload.chats[0]?.id).toBe(chatId);
    },
    { timeout: 30_000 },
  );

  test(
    "removes deleted chats from the search index",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-search-export");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Delete me");

      await appendMessage(backendServer.baseUrl, chatId, "user", "Vanishing search term.");
      await deleteChat(backendServer.baseUrl, chatId);

      const response = await fetch(
        `${backendServer.baseUrl}/api/chats?search=${encodeURIComponent("Vanishing search term")}`,
      );
      const payload = (await response.json()) as {
        chats: Array<{ id: string }>;
      };

      expect(response.status).toBe(200);
      expect(payload.chats).toHaveLength(0);
    },
    { timeout: 30_000 },
  );

  test(
    "exports persisted chats from the backend in json and markdown formats",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-search-export");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Export target");

      await appendMessage(backendServer.baseUrl, chatId, "user", "First prompt.");
      await appendMessage(
        backendServer.baseUrl,
        chatId,
        "assistant",
        "Structured answer.",
        "Private reasoning.",
      );

      const jsonResponse = await fetch(`${backendServer.baseUrl}/api/chats/export?format=json`);
      const jsonPayload = (await jsonResponse.json()) as {
        chats: Array<{
          chat: { id: string; title: string };
          messages: Array<{ content: string; reasoningContent?: string }>;
        }>;
        exportedAt: string;
      };
      const markdownResponse = await fetch(
        `${backendServer.baseUrl}/api/chats/export?format=markdown`,
      );
      const markdownPayload = await markdownResponse.text();

      expect(jsonResponse.status).toBe(200);
      expect(jsonResponse.headers.get("content-disposition")).toContain("chats-export.json");
      expect(jsonPayload.exportedAt.length).toBeGreaterThan(0);
      expect(jsonPayload.chats).toHaveLength(1);
      expect(jsonPayload.chats[0]?.chat.id).toBe(chatId);
      expect(jsonPayload.chats[0]?.messages[1]?.reasoningContent).toBe("Private reasoning.");

      expect(markdownResponse.status).toBe(200);
      expect(markdownResponse.headers.get("content-disposition")).toContain("chats-export.md");
      expect(markdownPayload).toContain("# Export target");
      expect(markdownPayload).toContain("## assistant");
      expect(markdownPayload).toContain("Private reasoning.");
    },
    { timeout: 30_000 },
  );

  test(
    "streams large exports incrementally so unrelated search requests still complete",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-search-export");

      const { controlChatId } = await seedLargeExportFixture(userDataDir);
      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const exportResponse = await withTimeout(
        fetch(`${backendServer.baseUrl}/api/chats/export?format=json`),
        2_000,
        "Timed out waiting for export response headers.",
      );

      expect(exportResponse.status).toBe(200);
      expect(exportResponse.headers.get("content-disposition")).toContain("chats-export.json");

      const searchResponse = await withTimeout(
        fetch(`${backendServer.baseUrl}/api/chats?search=${encodeURIComponent("Control marker")}`),
        2_000,
        "Timed out waiting for a concurrent search response during export streaming.",
      );
      const searchPayload = (await searchResponse.json()) as {
        chats: Array<{ id: string; title: string }>;
      };

      expect(searchResponse.status).toBe(200);
      expect(searchPayload.chats).toHaveLength(1);
      expect(searchPayload.chats[0]?.id).toBe(controlChatId);

      await exportResponse.body?.cancel();
    },
    { timeout: 120_000 },
  );
});

async function seedLargeExportFixture(userDataDir: string): Promise<{ controlChatId: string }> {
  const database = new AppDatabase(createApplicationPaths(userDataDir));
  const largeTranscriptContent = "Large export transcript ".repeat(2_048);

  try {
    const controlChat = await database.createChat("Concurrent search control");

    await database.appendMessage(controlChat.id, "user", "Control marker for concurrent search.");
    await database.appendMessage(controlChat.id, "assistant", "Control response.");

    for (let chatIndex = 0; chatIndex < 40; chatIndex += 1) {
      const chat = await database.createChat(`Bulk export ${String(chatIndex)}`);

      for (let messageIndex = 0; messageIndex < 6; messageIndex += 1) {
        await database.appendMessage(
          chat.id,
          messageIndex % 2 === 0 ? "user" : "assistant",
          `${String(chatIndex)}:${String(messageIndex)} ${largeTranscriptContent}`,
        );
      }
    }

    return {
      controlChatId: controlChat.id,
    };
  } finally {
    database.close();
  }
}

function createApplicationPaths(rootDir: string): ApplicationPaths {
  return {
    configFilePath: path.join(rootDir, "config.json"),
    databasePath: path.join(rootDir, "local-llm-gui.sqlite"),
    mediaDir: path.join(rootDir, "media"),
    staticOutDir: path.join(rootDir, "out"),
    tempDir: path.join(rootDir, "temp"),
    toolsDir: path.join(rootDir, "tools"),
    userDataDir: rootDir,
    workspaceRoot: rootDir,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  const timeoutPromise = Bun.sleep(timeoutMs).then(() => {
    throw new Error(errorMessage);
  });

  return await Promise.race([promise, timeoutPromise]);
}

async function createChat(baseUrl: string, title: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/chats`, {
    body: JSON.stringify({ title }),
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    method: "POST",
  });
  const payload = (await response.json()) as {
    chat: { id: string };
  };

  expect(response.status).toBe(201);

  return payload.chat.id;
}

async function appendMessage(
  baseUrl: string,
  chatId: string,
  role: "assistant" | "system" | "tool" | "user",
  content: string,
  reasoningContent?: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
    body: JSON.stringify({
      content,
      reasoningContent,
      role,
    }),
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    method: "POST",
  });
  const payload = (await response.json()) as {
    message: { id: string };
  };

  expect(response.status).toBe(201);

  return payload.message.id;
}

async function renameChat(baseUrl: string, chatId: string, title: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/chats/${chatId}/title`, {
    body: JSON.stringify({ title }),
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    method: "PUT",
  });

  expect(response.status).toBe(200);
}

async function editMessage(
  baseUrl: string,
  chatId: string,
  messageId: string,
  content: string,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/chats/${chatId}/edit`, {
    body: JSON.stringify({ content, messageId }),
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    method: "POST",
  });

  expect(response.status).toBe(200);
}

async function deleteChat(baseUrl: string, chatId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/chats/${chatId}`, {
    method: "DELETE",
    headers: {
      Origin: baseUrl,
    },
  });

  expect(response.status).toBe(200);
}

async function startBackendServer(
  port: number,
  userDataDir: string,
): Promise<{ baseUrl: string; process: ChildProcess }> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = {
    stderr: "",
    stdout: "",
  };
  const backendProcess = spawn(
    process.execPath,
    ["src/backend/server.ts", `--port=${port}`, "--dev-proxy"],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        LOCAL_LLM_GUI_DISABLE_BROWSER: "1",
        LOCAL_LLM_GUI_FRONTEND_ORIGIN: "http://127.0.0.1:3000",
        LOCAL_LLM_GUI_USER_DATA_DIR: userDataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  backendProcess.stdout?.on("data", (chunk: Buffer | string) => {
    output.stdout += chunk.toString();
  });
  backendProcess.stderr?.on("data", (chunk: Buffer | string) => {
    output.stderr += chunk.toString();
  });

  await waitForBackendReady(baseUrl, backendProcess, output);

  return {
    baseUrl,
    process: backendProcess,
  };
}

async function waitForBackendReady(
  baseUrl: string,
  backendProcess: ChildProcess,
  output: { stderr: string; stdout: string },
): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (backendProcess.exitCode !== null) {
      throw new Error(
        [
          `Backend exited before becoming healthy with code ${String(backendProcess.exitCode)}.`,
          output.stdout.trim(),
          output.stderr.trim(),
        ]
          .filter((part) => part.length > 0)
          .join("\n\n"),
      );
    }

    try {
      const healthResponse = await fetch(`${baseUrl}/api/health`);

      if (healthResponse.ok) {
        return;
      }
    } catch {
      // Retry until the server is ready or the deadline elapses.
    }

    await Bun.sleep(100);
  }

  throw new Error(
    ["Timed out waiting for backend readiness.", output.stdout.trim(), output.stderr.trim()]
      .filter((part) => part.length > 0)
      .join("\n\n"),
  );
}

async function allocatePort(): Promise<number> {
  const candidatePort = await new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a test port."));
        return;
      }

      resolve(address.port);
      server.close();
    });

    server.on("error", reject);
  });

  return candidatePort;
}
