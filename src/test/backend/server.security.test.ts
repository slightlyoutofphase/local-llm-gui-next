import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import {
  createBackendTestScratchDir,
  removeBackendTestScratchDir,
  stopBackendTestProcess,
} from "./testScratch";

describe("backend server write-route hardening", () => {
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
    "rejects foreign browser origins on JSON write routes",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/chats`, {
        body: JSON.stringify({ title: "Blocked chat" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.example",
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(403);
      expect(payload.error).toContain("Cross-origin");
    },
    { timeout: 30_000 },
  );

  test(
    "rejects cross-site browser write metadata even when the Origin header is absent",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/chats`, {
        body: JSON.stringify({ title: "Blocked metadata chat" }),
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "cross-site",
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(403);
      expect(payload.error).toContain("Cross-origin");
    },
    { timeout: 30_000 },
  );

  test(
    "rejects write routes without an Origin header when no secret is configured",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/chats`, {
        body: JSON.stringify({ title: "Blocked chat" }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(403);
      expect(payload.error).toContain("trusted origin");
    },
    { timeout: 30_000 },
  );

  test(
    "rejects non-JSON content types on JSON write routes",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/chats`, {
        body: JSON.stringify({ title: "Wrong content type" }),
        headers: {
          "Content-Type": "text/plain",
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(415);
      expect(payload.error).toContain("application/json");
    },
    { timeout: 30_000 },
  );

  test(
    "rejects empty JSON bodies on JSON write routes",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/chats`, {
        body: "",
        headers: {
          "Content-Type": "application/json",
          Origin: backendServer.baseUrl,
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(400);
      expect(payload.error).toBe("Request body is required.");
    },
    { timeout: 30_000 },
  );

  test(
    "allows same-origin JSON writes",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/chats`, {
        body: JSON.stringify({ title: "Allowed chat" }),
        headers: {
          "Content-Type": "application/json",
          Origin: backendServer.baseUrl,
        },
        method: "POST",
      });
      const payload = (await response.json()) as {
        chat?: { title?: string };
        dbRevision?: number;
      };

      expect(response.status).toBe(201);
      expect(payload.chat?.title).toBe("Allowed chat");
      expect(typeof payload.dbRevision).toBe("number");
    },
    { timeout: 30_000 },
  );

  test(
    "allows trusted origins configured through LOCAL_LLM_GUI_TRUSTED_ORIGINS",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir, {
        LOCAL_LLM_GUI_TRUSTED_ORIGINS: "http://trusted.example",
      });

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/chats`, {
        body: JSON.stringify({ title: "Trusted origin chat" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "http://trusted.example",
        },
        method: "POST",
      });
      const payload = (await response.json()) as {
        chat?: { title?: string };
        dbRevision?: number;
      };

      expect(response.status).toBe(201);
      expect(payload.chat?.title).toBe("Trusted origin chat");
      expect(typeof payload.dbRevision).toBe("number");
    },
    { timeout: 30_000 },
  );

  test(
    "returns 400 for malformed percent-encoding in tool confirmation paths instead of surfacing a server error",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(
        `${backendServer.baseUrl}/api/chats/%E0%A4%A/tool-confirmation`,
        {
          body: JSON.stringify({ approved: true, assistantMessageId: crypto.randomUUID() }),
          headers: {
            "Content-Type": "application/json",
            Origin: backendServer.baseUrl,
          },
          method: "POST",
        },
      );
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(400);
      expect(payload.error).toContain("malformed percent-encoding");
    },
    { timeout: 30_000 },
  );

  test(
    "rejects malformed multipart upload bodies with a bounded 400 response",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const response = await fetch(`${backendServer.baseUrl}/api/media/upload`, {
        body: "not-a-valid-multipart-body",
        headers: {
          "Content-Type": "multipart/form-data",
          Origin: backendServer.baseUrl,
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(400);
      expect(payload.error).toContain("multipart/form-data");
    },
    { timeout: 30_000 },
  );

  test(
    "rejects oversized JSON bodies with an explicit 413 response",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-security");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const oversizedBody = JSON.stringify({
        payload: "x".repeat(10 * 1024 * 1024 + 128),
      });
      const response = await fetch(`${backendServer.baseUrl}/api/chats`, {
        body: oversizedBody,
        headers: {
          "Content-Type": "application/json",
          Origin: backendServer.baseUrl,
        },
        method: "POST",
      });
      const payload = (await response.json()) as { error?: string };

      expect(response.status).toBe(413);
      expect(payload.error).toContain("exceeds limit");
    },
    { timeout: 30_000 },
  );
});

async function startBackendServer(
  port: number,
  userDataDir: string,
  envOverrides: Record<string, string> = {},
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
        ...envOverrides,
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

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
