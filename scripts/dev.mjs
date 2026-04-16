import { spawn } from "node:child_process";

const backendPort = process.env.LOCAL_LLM_GUI_BACKEND_PORT ?? "4000";
const frontendOrigin = process.env.LOCAL_LLM_GUI_FRONTEND_ORIGIN ?? "http://127.0.0.1:3000";
const shouldOpenBrowser = process.env.LOCAL_LLM_GUI_DISABLE_BROWSER !== "1";

const backendProcess = spawn(
  process.execPath,
  ["--watch", "src/backend/server.ts", `--port=${backendPort}`, "--dev-proxy"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOCAL_LLM_GUI_DISABLE_BROWSER: "1",
      LOCAL_LLM_GUI_FRONTEND_ORIGIN: frontendOrigin,
    },
    stdio: "inherit",
  },
);

const frontendBinaryPath = process.platform === "win32" ? ".\\node_modules\\.bin\\next.cmd" : "./node_modules/.bin/next";
const frontendProcess = spawn(frontendBinaryPath, ["dev", "--turbopack"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    LOCAL_LLM_GUI_BACKEND_ORIGIN: `http://127.0.0.1:${backendPort}`,
  },
  stdio: "inherit",
  shell: process.platform === "win32",
});

const readyBrowserPromise = shouldOpenBrowser ? waitForFrontendAndOpenBrowser(frontendOrigin) : Promise.resolve();

void readyBrowserPromise;

let shuttingDown = false;

const shutdown = (exitCode = 0) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  backendProcess.kill();
  frontendProcess.kill();
  process.exit(exitCode);
};

backendProcess.on("exit", (code) => {
  shutdown(code ?? 0);
});

frontendProcess.on("exit", (code) => {
  shutdown(code ?? 0);
});

for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signalName, () => {
    shutdown(0);
  });
}

async function waitForFrontendAndOpenBrowser(targetUrl) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(targetUrl, { redirect: "manual" });

      if (response.ok || response.status === 307 || response.status === 308) {
        openBrowser(targetUrl);
        return;
      }
    } catch {
      // The dev server is not ready yet.
    }

    await Bun.sleep(250);
  }

  console.warn(`Timed out waiting for the development frontend at ${targetUrl}.`);
}

function openBrowser(targetUrl) {
  const command =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", targetUrl]
      : process.platform === "darwin"
        ? ["open", targetUrl]
        : ["xdg-open", targetUrl];

  spawn(command[0], command.slice(1), {
    detached: true,
    stdio: "ignore",
  }).unref();
}