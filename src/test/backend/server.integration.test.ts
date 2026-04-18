import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import type { ModelRecord, RuntimeSnapshot } from "../../lib/contracts";
import { consumeJsonSseEvents, flushJsonSseBuffer } from "../../lib/sseClient";
import {
  createBackendTestScratchDir,
  removeBackendTestScratchDir,
  stopBackendTestProcess,
} from "./testScratch";

const FRONTEND_ORIGIN = "http://127.0.0.1:3101";
const TARGET_MODEL_ID = "unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q8_0.gguf";

describe("backend server integration", () => {
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
    "dev-proxy mode keeps runtime polling and runtime SSE in sync during a real model load",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-server");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const redirectResponse = await fetch(`${backendServer.baseUrl}/`, {
        headers: { Accept: "text/html" },
        redirect: "manual",
      });

      expect(redirectResponse.status).toBe(307);
      expect(redirectResponse.headers.get("location")).toBe(`${FRONTEND_ORIGIN}/`);

      const modelsPayload = await fetchJson<{ models: ModelRecord[] }>(
        `${backendServer.baseUrl}/api/models`,
      );
      const testModel = modelsPayload.models.find((model) => model.id === TARGET_MODEL_ID) ?? null;

      expect(testModel).not.toBeNull();

      const runtimeStreamAbortController = new AbortController();
      const runtimeStreamResponse = await fetch(`${backendServer.baseUrl}/api/events/runtime`, {
        signal: runtimeStreamAbortController.signal,
      });

      expect(runtimeStreamResponse.ok).toBe(true);
      expect(runtimeStreamResponse.headers.get("content-type")).toContain("text/event-stream");

      const runtimeEventsPromise = collectRuntimeSnapshotsUntilReady(runtimeStreamResponse);
      const loadResponsePromise = fetch(`${backendServer.baseUrl}/api/models/load`, {
        body: JSON.stringify({ modelId: TARGET_MODEL_ID }),
        headers: {
          "Content-Type": "application/json",
          Origin: FRONTEND_ORIGIN,
        },
        method: "POST",
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Load failed with ${res.status}: ${text}`);
        }
        return res;
      });

      const polledSnapshots = await Promise.race([
        pollRuntimeSnapshotsUntilReady(backendServer.baseUrl),
        loadResponsePromise.then(() => new Promise<never>(() => {})), // Never resolves if ok, throws if not
      ]);
      const loadResponse = await loadResponsePromise;
      const runtimeEvents = await runtimeEventsPromise;

      runtimeStreamAbortController.abort();

      expect(loadResponse.ok).toBe(true);

      const loadPayload = (await loadResponse.json()) as {
        runtime: RuntimeSnapshot;
      };
      const polledLoadingSnapshot = polledSnapshots.find(
        (snapshot) => snapshot.status === "loading",
      );
      const finalPolledSnapshot = polledSnapshots.at(-1) ?? null;
      const progressSnapshots = runtimeEvents.filter(
        (snapshot) => snapshot.status === "loading" && typeof snapshot.loadProgress === "number",
      );
      const finalEventSnapshot = runtimeEvents.at(-1) ?? null;

      expect(loadPayload.runtime.status).toBe("ready");
      expect(loadPayload.runtime.activeModelId).toBe(TARGET_MODEL_ID);
      expect(polledLoadingSnapshot).not.toBeNull();
      expect(finalPolledSnapshot?.status).toBe("ready");
      expect(finalPolledSnapshot?.activeModelId).toBe(TARGET_MODEL_ID);
      expect(progressSnapshots.length).toBeGreaterThan(0);
      expect(progressSnapshots.some((snapshot) => (snapshot.loadProgress ?? 0) > 0)).toBe(true);
      expect(finalEventSnapshot?.status).toBe("ready");
      expect(finalEventSnapshot?.activeModelId).toBe(TARGET_MODEL_ID);
      expect(finalEventSnapshot?.loadProgress).toBe(100);

      const unloadResponse = await fetch(`${backendServer.baseUrl}/api/models/unload`, {
        headers: {
          Origin: FRONTEND_ORIGIN,
        },
        method: "POST",
      });

      expect(unloadResponse.ok).toBe(true);
    },
    { timeout: 180_000 },
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
        LOCAL_LLM_GUI_FRONTEND_ORIGIN: FRONTEND_ORIGIN,
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

async function pollRuntimeSnapshotsUntilReady(baseUrl: string): Promise<RuntimeSnapshot[]> {
  const snapshots: RuntimeSnapshot[] = [];
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    const snapshot = await fetchJson<RuntimeSnapshot>(`${baseUrl}/api/runtime`);

    snapshots.push(snapshot);

    if (snapshot.status === "ready") {
      return snapshots;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for /api/runtime to reach the ready state.");
}

async function collectRuntimeSnapshotsUntilReady(response: Response): Promise<RuntimeSnapshot[]> {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("The runtime SSE response did not provide a readable body.");
  }

  const decoder = new TextDecoder();
  const snapshots: RuntimeSnapshot[] = [];
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const parsed = consumeJsonSseEvents(buffer);

      buffer = parsed.remainder;

      for (const envelope of parsed.payloads) {
        const snapshot = asRuntimeSnapshot(envelope);

        if (!snapshot) {
          continue;
        }

        snapshots.push(snapshot);

        if (snapshot.status === "ready") {
          await reader.cancel();
          return snapshots;
        }
      }
    }

    for (const envelope of flushJsonSseBuffer(buffer)) {
      const snapshot = asRuntimeSnapshot(envelope);

      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    return snapshots;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function asRuntimeSnapshot(envelope: Record<string, unknown>): RuntimeSnapshot | null {
  const payload = envelope["payload"];

  if (!payload || typeof payload !== "object") {
    return null;
  }

  return payload as RuntimeSnapshot;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
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
