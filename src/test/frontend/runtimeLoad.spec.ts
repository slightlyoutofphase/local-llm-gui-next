import path from "node:path";
import { expect, test } from "@playwright/test";

const TARGET_MODEL_ID = "unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q8_0.gguf";
const TARGET_MODEL_NAME = "Qwen3.5-0.8B-GGUF";
const TARGET_MODEL_FILE = "Qwen3.5-0.8B-Q8_0.gguf";
const BACKEND_BASE_URL = "http://127.0.0.1:4000";
const TARGET_LLAMA_SERVER_PATH = path.resolve("vendor/llama-cpp/llama-server.exe");
const TARGET_MODELS_PATH = path.resolve("test/models");

test("advances the real model load bar above zero before the runtime becomes ready", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  await expect
    .poll(
      async () => {
        try {
          const configReadinessResponse = await request.get(`${BACKEND_BASE_URL}/api/config`);

          return configReadinessResponse.status();
        } catch {
          return 0;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(200);

  const configResponse = await request.put(`${BACKEND_BASE_URL}/api/config`, {
    data: {
      llamaServerPath: TARGET_LLAMA_SERVER_PATH,
      modelsPath: TARGET_MODELS_PATH,
    },
  });

  expect(configResponse.ok()).toBe(true);
  await request.post(`${BACKEND_BASE_URL}/api/models/unload`);

  await page.goto("/");

  const modelButton = page
    .getByRole("button")
    .filter({ hasText: TARGET_MODEL_NAME })
    .filter({ hasText: TARGET_MODEL_FILE });
  const loadButton = page.getByRole("button", { name: "Load model", exact: true });
  const progressLabel = page.getByTestId("runtime-load-progress-label");

  await expect(modelButton).toBeVisible({ timeout: 120_000 });
  await modelButton.click();
  await expect(loadButton).toBeEnabled();
  await loadButton.click();

  await expect(progressLabel).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(
      async () => {
        if (!(await progressLabel.isVisible())) {
          return 0;
        }

        const progressText = (await progressLabel.textContent())?.trim() ?? "0%";
        const numericProgress = Number.parseInt(progressText, 10);

        return Number.isFinite(numericProgress) ? numericProgress : 0;
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0);

  await expect
    .poll(
      async () => {
        const runtimeResponse = await request.get(`${BACKEND_BASE_URL}/api/runtime`);

        if (!runtimeResponse.ok()) {
          return "error";
        }

        const runtimeSnapshot = (await runtimeResponse.json()) as {
          status: string;
        };

        return runtimeSnapshot.status;
      },
      { timeout: 120_000 },
    )
    .toBe("ready");

  const readyRuntimeResponse = await request.get(`${BACKEND_BASE_URL}/api/runtime`);

  expect(readyRuntimeResponse.ok()).toBe(true);

  const readyRuntimeSnapshot = (await readyRuntimeResponse.json()) as {
    activeModelId: string | null;
    loadProgress: number | null;
    status: string;
  };

  expect(readyRuntimeSnapshot.status).toBe("ready");
  expect(readyRuntimeSnapshot.activeModelId).toBe(TARGET_MODEL_ID);
  expect(readyRuntimeSnapshot.loadProgress).toBe(100);
  await expect(progressLabel).toBeHidden({ timeout: 30_000 });

  await request.post(`${BACKEND_BASE_URL}/api/models/unload`);
});
