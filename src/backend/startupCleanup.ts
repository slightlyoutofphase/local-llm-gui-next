import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ApplicationPaths } from "./paths";

interface StartupTemplateSweepOptions {
  applicationPaths: ApplicationPaths;
  log: (message: string) => void;
  minimumAgeMs?: number;
  now?: number;
  protectedFilePaths?: string[];
}

/**
 * Reclaims stale temporary Jinja override files left in the backend temp directory.
 */
export async function sweepStartupTemplateOverrideFiles(
  options: StartupTemplateSweepOptions,
): Promise<void> {
  if (!existsSync(options.applicationPaths.tempDir)) {
    return;
  }

  const minimumAgeMs = options.minimumAgeMs ?? 0;
  const protectedFilePaths = new Set(
    (options.protectedFilePaths ?? []).map((filePath) => path.resolve(filePath)),
  );
  const removedTemplateFiles: string[] = [];
  const tempEntries = await readdir(options.applicationPaths.tempDir, { withFileTypes: true });

  for (const tempEntry of tempEntries) {
    if (!tempEntry.isFile() || !tempEntry.name.endsWith(".jinja")) {
      continue;
    }

    const templateFilePath = path.join(options.applicationPaths.tempDir, tempEntry.name);

    if (protectedFilePaths.has(path.resolve(templateFilePath))) {
      continue;
    }

    if (
      !(await isPathOlderThanMinimumAge({
        minimumAgeMs,
        now: options.now ?? Date.now(),
        targetPath: templateFilePath,
      }))
    ) {
      continue;
    }

    try {
      await rm(templateFilePath, { force: true });
      removedTemplateFiles.push(templateFilePath);
    } catch (error) {
      options.log(
        `Failed to delete stale temporary Jinja override file ${templateFilePath}: ${formatStartupCleanupError(error)}`,
      );
    }
  }

  if (removedTemplateFiles.length > 0) {
    options.log(
      `Removed ${String(removedTemplateFiles.length)} stale temporary Jinja override file${removedTemplateFiles.length === 1 ? "" : "s"} during startup cleanup.`,
    );
  }
}

async function isPathOlderThanMinimumAge(options: {
  minimumAgeMs: number;
  now: number;
  targetPath: string;
}): Promise<boolean> {
  if (options.minimumAgeMs <= 0) {
    return true;
  }

  try {
    const targetStats = await stat(options.targetPath);
    return options.now - targetStats.mtimeMs >= options.minimumAgeMs;
  } catch {
    return false;
  }
}

function formatStartupCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
