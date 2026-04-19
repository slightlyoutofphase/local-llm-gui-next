import path from "node:path";
import { defineConfig } from "@playwright/test";

const frontendPort = "3000";
const backendPort = "4000";
const baseUrl = `http://127.0.0.1:${frontendPort}`;

export default defineConfig({
  expect: {
    timeout: 15000,
  },
  testDir: "./src/test/frontend",
  testMatch: "**/*.spec.ts",
  timeout: 90000,
  use: {
    baseURL: baseUrl,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    env: {
      LOCAL_LLM_GUI_BACKEND_PORT: backendPort,
      LOCAL_LLM_GUI_DISABLE_BROWSER: "1",
      LOCAL_LLM_GUI_FRONTEND_ORIGIN: baseUrl,
      LOCAL_LLM_GUI_USER_DATA_DIR: path.join(process.cwd(), ".playwright", "user-data"),
      PORT: frontendPort,
    },
    reuseExistingServer: !process.env["CI"],
    timeout: 180000,
    url: baseUrl,
  },
  workers: 1,
});
