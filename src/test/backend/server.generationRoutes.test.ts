import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import {
  createBackendTestScratchDir,
  removeBackendTestScratchDir,
  stopBackendTestProcess,
} from "./testScratch";

describe("backend fetch-handled generation routes", () => {
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
    "routes POST /api/generate/chat through the fetch handler instead of the API catch-all",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-generation-routes");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/generate/chat`, {
        body: JSON.stringify({
          chatId: "chat-1",
          stream: true,
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: backendServer.baseUrl,
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(404);
      expect(payload.error).toContain("chat-1");
    },
    { timeout: 30_000 },
  );

  test(
    "routes POST /api/generate/completion through the fetch handler instead of the API catch-all",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-generation-routes");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/generate/completion`, {
        body: JSON.stringify({
          prompt: "hello",
          stream: false,
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: backendServer.baseUrl,
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(409);
      expect(payload.error).toBe("No model is currently loaded.");
    },
    { timeout: 30_000 },
  );

  test(
    "routes POST /api/chats/:chatId/tool-confirmation through the fetch handler",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-generation-routes");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/chats/missing/tool-confirmation`, {
        body: JSON.stringify({
          approved: true,
          assistantMessageId: "assistant-1",
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: backendServer.baseUrl,
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(404);
      expect(payload.error).toBe("Chat not found: missing");
    },
    { timeout: 30_000 },
  );
});

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
      // The backend has not started listening yet.
    }

    await delay(100);
  }

  throw new Error(
    [
      `Timed out waiting for the backend to become healthy at ${baseUrl}.`,
      output.stdout.trim(),
      output.stderr.trim(),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n"),
  );
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probeServer = createServer();

    probeServer.once("error", reject);
    probeServer.listen(0, "127.0.0.1", () => {
      const address = probeServer.address();

      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a local test port."));
        return;
      }

      const resolvedPort = address.port;

      probeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(resolvedPort);
      });
    });
  });
}

async function delay(milliseconds: number): Promise<void> {
  await Bun.sleep(milliseconds);
}
