import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import type { UploadMediaAttachmentsResponse } from "../../lib/api";
import type { ChatMessageRecord } from "../../lib/contracts";
import {
  createBackendTestScratchDir,
  removeBackendTestScratchDir,
  stopBackendTestProcess,
} from "./testScratch";

describe("backend attachment staging", () => {
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
    "finalizes staged uploads from trusted attachment IDs instead of client paths",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-attachments");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Attachment trust");
      const messageId = crypto.randomUUID();
      const uploadPayload = await uploadFiles(backendServer.baseUrl, chatId, messageId, [
        new File([createTinyPngBuffer()], "pixel.png", { type: "image/png" }),
      ]);
      const stagedAttachment = uploadPayload.attachments[0]!;

      expect(existsSync(stagedAttachment.filePath)).toBe(true);

      const appendResponse = await fetch(`${backendServer.baseUrl}/api/chats/${chatId}/messages`, {
        body: JSON.stringify({
          content: "Inspect this image.",
          mediaAttachments: [stagedAttachment],
          messageId,
          role: "user",
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: backendServer.baseUrl,
        },
        method: "POST",
      });

      expect(appendResponse.status).toBe(201);

      const appendPayload = (await appendResponse.json()) as {
        message: ChatMessageRecord;
      };
      const finalizedAttachment = appendPayload.message.mediaAttachments[0]!;

      expect(finalizedAttachment.filePath).not.toBe(stagedAttachment.filePath);
      expect(existsSync(stagedAttachment.filePath)).toBe(false);
      expect(existsSync(finalizedAttachment.filePath)).toBe(true);

      const mediaResponse = await fetch(
        `${backendServer.baseUrl}/api/chats/${chatId}/media/${finalizedAttachment.id}/`,
      );

      expect(mediaResponse.ok).toBe(true);

      await stopBackendTestProcess(backendServer.process);
      serverProcess = null;
    },
    { timeout: 30_000 },
  );

  test(
    "routes multipart upload through explicit /api/media/upload route",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-attachments");
      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Attachment route test");
      const messageId = crypto.randomUUID();
      const uploadPayload = await uploadFiles(backendServer.baseUrl, chatId, messageId, [
        new File([createTinyPngBuffer()], "pixel.png", { type: "image/png" }),
      ]);

      expect(uploadPayload.attachments.length).toBe(1);
      expect(uploadPayload.attachments[0]?.kind).toBe("image");
      expect(uploadPayload.attachments[0]?.filePath).toContain(".pending");

      await stopBackendTestProcess(backendServer.process);
      serverProcess = null;
    },
    { timeout: 30_000 },
  );

  test(
    "accepts chunked multipart uploads without a Content-Length header",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-attachments");
      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Chunked upload test");
      const messageId = crypto.randomUUID();
      const boundary = "----local-llm-gui-test-boundary";
      const fileBuffer = createTinyPngBuffer();

      const requestBody = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="chatId"\r\n\r\n${chatId}\r\n`,
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="messageId"\r\n\r\n${messageId}\r\n`,
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        fileBuffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const response = await new Promise<{ statusCode: number; body: string }>(
        (resolve, reject) => {
          const request = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/api/media/upload",
              method: "POST",
              headers: {
                Origin: backendServer.baseUrl,
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
              },
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                body += chunk;
              });
              res.on("end", () => {
                resolve({ statusCode: res.statusCode ?? 0, body });
              });
            },
          );

          request.on("error", reject);
          request.write(requestBody);
          request.end();
        },
      );

      expect(response.statusCode).toBe(201);
      expect(response.body).toContain('"attachments"');

      await stopBackendTestProcess(backendServer.process);
      serverProcess = null;
    },
    { timeout: 30_000 },
  );

  test(
    "replaces stale staged files when the same message slot is re-uploaded",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-attachments");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Attachment retry");
      const messageId = crypto.randomUUID();
      const firstUpload = await uploadFiles(backendServer.baseUrl, chatId, messageId, [
        new File([createTinyPngBuffer()], "first.png", { type: "image/png" }),
      ]);
      const secondUpload = await uploadFiles(backendServer.baseUrl, chatId, messageId, [
        new File([createTinyPngBuffer()], "second.png", { type: "image/png" }),
      ]);

      expect(existsSync(firstUpload.attachments[0]!.filePath)).toBe(false);
      expect(existsSync(secondUpload.attachments[0]!.filePath)).toBe(true);

      await stopBackendTestProcess(backendServer.process);
      serverProcess = null;
    },
    { timeout: 30_000 },
  );

  test(
    "serves persisted media through GET and HEAD without requiring trailing slashes",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-attachments");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Attachment media lookup");
      const messageId = crypto.randomUUID();
      const uploadPayload = await uploadFiles(backendServer.baseUrl, chatId, messageId, [
        new File([createTinyPngBuffer()], "pixel.png", { type: "image/png" }),
      ]);
      const appendResponse = await fetch(`${backendServer.baseUrl}/api/chats/${chatId}/messages`, {
        body: JSON.stringify({
          content: "Inspect this image.",
          mediaAttachments: uploadPayload.attachments,
          messageId,
          role: "user",
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: backendServer.baseUrl,
        },
        method: "POST",
      });
      const appendPayload = (await appendResponse.json()) as {
        message: {
          mediaAttachments: Array<{ byteSize: number; id: string }>;
        };
      };
      const finalizedAttachment = appendPayload.message.mediaAttachments[0]!;

      expect(appendResponse.status).toBe(201);

      for (let messageIndex = 0; messageIndex < 6; messageIndex += 1) {
        await appendMessage(
          backendServer.baseUrl,
          chatId,
          `Transcript filler message ${String(messageIndex)}.`,
        );
      }

      const headResponse = await fetch(
        `${backendServer.baseUrl}/api/chats/${chatId}/media/${finalizedAttachment.id}`,
        {
          method: "HEAD",
        },
      );
      const getResponse = await fetch(
        `${backendServer.baseUrl}/api/chats/${chatId}/media/${finalizedAttachment.id}`,
      );

      expect(headResponse.status).toBe(200);
      expect(headResponse.headers.get("content-length")).toBe(String(finalizedAttachment.byteSize));
      expect(headResponse.headers.get("content-type")).toBe("image/png");
      expect(headResponse.headers.get("cache-control")).toContain("max-age");
      expect(headResponse.headers.get("accept-ranges")).toBe("bytes");
      expect(await headResponse.text()).toBe("");

      expect(getResponse.status).toBe(200);
      expect(getResponse.headers.get("content-type")).toBe("image/png");
      expect(getResponse.headers.get("cache-control")).toContain("max-age");
      expect(getResponse.headers.get("accept-ranges")).toBe("bytes");
      expect((await getResponse.arrayBuffer()).byteLength).toBe(finalizedAttachment.byteSize);
    },
    { timeout: 30_000 },
  );

  test(
    "does not leave partial staged files behind when a later upload in the batch is invalid",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-attachments");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Attachment validation");
      const response = await uploadFilesRaw(backendServer.baseUrl, chatId, crypto.randomUUID(), [
        new File([createTinyPngBuffer()], "valid.png", { type: "image/png" }),
        new File([Buffer.from("oops")], "payload.exe", { type: "application/octet-stream" }),
      ]);
      const payload = (await response.json()) as { error?: string };
      const chatMediaDirectory = path.join(userDataDir, "media", chatId);

      expect(response.status).toBe(400);
      expect(payload.error).toContain("Unsupported attachment type");
      expect(existsSync(chatMediaDirectory)).toBe(false);
    },
    { timeout: 30_000 },
  );

  test(
    "normalizes generic octet-stream uploads to the shared text MIME fallback",
    async () => {
      userDataDir = await createBackendTestScratchDir("local-llm-gui-attachments");

      const port = await allocatePort();
      const backendServer = await startBackendServer(port, userDataDir);

      serverProcess = backendServer.process;

      const chatId = await createChat(backendServer.baseUrl, "Attachment MIME classification");
      const response = await uploadFilesRaw(backendServer.baseUrl, chatId, crypto.randomUUID(), [
        new File([JSON.stringify({ ok: true })], "settings.json", {
          type: "application/octet-stream",
        }),
      ]);
      const payload = (await response.json()) as {
        attachments: Array<{
          filePath: string;
          kind: string;
          mimeType: string;
        }>;
      };

      expect(response.status).toBe(201);
      expect(payload.attachments[0]?.kind).toBe("text");
      expect(payload.attachments[0]?.mimeType).toBe("application/json");
      expect(existsSync(payload.attachments[0]?.filePath ?? "")).toBe(true);
    },
    { timeout: 30_000 },
  );
});

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

async function uploadFiles(
  baseUrl: string,
  chatId: string,
  messageId: string,
  files: File[],
): Promise<UploadMediaAttachmentsResponse> {
  const response = await uploadFilesRaw(baseUrl, chatId, messageId, files);
  const payload = (await response.json()) as UploadMediaAttachmentsResponse;

  expect(response.status).toBe(201);

  return payload;
}

async function appendMessage(baseUrl: string, chatId: string, content: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
    body: JSON.stringify({
      content,
      role: "user",
    }),
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    method: "POST",
  });

  expect(response.status).toBe(201);
}

async function uploadFilesRaw(
  baseUrl: string,
  chatId: string,
  messageId: string,
  files: File[],
): Promise<Response> {
  const formData = new FormData();

  formData.set("chatId", chatId);
  formData.set("messageId", messageId);

  for (const file of files) {
    formData.append("files", file);
  }

  return await fetch(`${baseUrl}/api/media/upload`, {
    body: formData,
    headers: {
      Origin: baseUrl,
    },
    method: "POST",
  });
}

function createTinyPngBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
    0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0x1f, 0x00,
    0x03, 0x03, 0x02, 0x00, 0xef, 0xef, 0xf9, 0x7a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);
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
