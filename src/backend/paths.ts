import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Represents the filesystem locations used by the backend runtime.
 */
export interface ApplicationPaths {
  /** Current workspace root used during development. */
  workspaceRoot: string;
  /** User-scoped data directory for config, database, media, and temp files. */
  userDataDir: string;
  /** JSON config file path. */
  configFilePath: string;
  /** SQLite database file path. */
  databasePath: string;
  /** Persistent media storage directory. */
  mediaDir: string;
  /** User-authored local tool directory. */
  toolsDir: string;
  /** Temporary runtime file directory. */
  tempDir: string;
  /** Static export directory served by Bun.serve. */
  staticOutDir: string;
}

/**
 * Resolves the application path set for the current runtime.
 *
 * @returns The resolved application path bundle.
 */
export function getApplicationPaths(): ApplicationPaths {
  const workspaceRoot = process.cwd();
  const userDataDir = getUserDataDirectory();

  return {
    workspaceRoot,
    userDataDir,
    configFilePath: path.join(userDataDir, "config.json"),
    databasePath: path.join(userDataDir, "local-llm-gui.sqlite"),
    mediaDir: path.join(userDataDir, "media"),
    toolsDir: path.join(userDataDir, "tools"),
    tempDir: path.join(userDataDir, "temp"),
    staticOutDir: path.join(workspaceRoot, "out"),
  };
}

/**
 * Ensures that the backend-owned user-data directories exist.
 *
 * @param applicationPaths The resolved application path bundle.
 * @returns A promise that resolves once all directories exist.
 */
export async function ensureApplicationDirectories(
  applicationPaths: ApplicationPaths,
): Promise<void> {
  await Promise.all([
    mkdir(applicationPaths.userDataDir, { recursive: true }),
    mkdir(applicationPaths.mediaDir, { recursive: true }),
    mkdir(applicationPaths.toolsDir, { recursive: true }),
    mkdir(applicationPaths.tempDir, { recursive: true }),
  ]);
}

/**
 * Resolves the workspace-local default `llama-server` path when available.
 *
 * @param applicationPaths The resolved application path bundle.
 * @returns The discovered binary path or an empty string.
 */
export function getDefaultWorkspaceLlamaServerPath(applicationPaths: ApplicationPaths): string {
  const candidate = path.join(
    applicationPaths.workspaceRoot,
    "vendor",
    "llama-cpp",
    "llama-server.exe",
  );

  return existsSync(candidate) ? candidate : "";
}

/**
 * Resolves the workspace-local default models directory when available.
 *
 * @param applicationPaths The resolved application path bundle.
 * @returns The discovered models root or an empty string.
 */
export function getDefaultWorkspaceModelsPath(applicationPaths: ApplicationPaths): string {
  const candidate = path.join(applicationPaths.workspaceRoot, "test", "models");

  return existsSync(candidate) ? candidate : "";
}

function getUserDataDirectory(): string {
  const overrideDirectory = process.env["LOCAL_LLM_GUI_USER_DATA_DIR"];

  if (overrideDirectory) {
    return overrideDirectory;
  }

  if (process.platform === "win32") {
    const roamingDirectory = process.env["APPDATA"];

    if (roamingDirectory) {
      return path.join(roamingDirectory, "Local LLM GUI");
    }
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Local LLM GUI");
  }

  return path.join(os.homedir(), ".local", "share", "local-llm-gui");
}
