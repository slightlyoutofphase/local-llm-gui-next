import { readFile, writeFile } from "node:fs/promises";
import type { AppConfig, DebugLogSettings } from "../lib/contracts";
import {
  ensureApplicationDirectories,
  getDefaultWorkspaceLlamaServerPath,
  getDefaultWorkspaceModelsPath,
  type ApplicationPaths,
} from "./paths";

/** Subset of {@link AppConfig} fields accepted by {@link ConfigStore.updateConfig}. */
interface AppConfigUpdate {
  llamaServerPath?: string;
  modelsPath?: string;
  customBinaries?: Record<string, string>;
  theme?: AppConfig["theme"];
  autoNamingEnabled?: boolean;
  toolEnabledStates?: Record<string, boolean>;
  debug?: Partial<DebugLogSettings>;
}

const DEFAULT_DEBUG_SETTINGS: DebugLogSettings = {
  enabled: true,
  showProcessStdout: true,
  showProcessStderr: true,
  showServerLogs: true,
  verboseServerLogs: false,
  maxEntries: 1000,
};

/**
 * Persists and retrieves the global application configuration JSON file.
 */
export class ConfigStore {
  private cachedConfig: AppConfig | null = null;
  private loadWarning: string | null = null;

  /**
   * Creates a new configuration store.
   *
   * @param applicationPaths The resolved application path bundle.
   */
  public constructor(private readonly applicationPaths: ApplicationPaths) {}

  /**
   * Returns the latest non-destructive config recovery warning, if any.
   *
   * @returns The current recovery warning.
   */
  public getLoadWarning(): string | null {
    return this.loadWarning;
  }

  /**
   * Loads the persisted configuration, creating it on first access when needed.
   *
   * @returns The persisted application configuration.
   */
  public async getConfig(): Promise<AppConfig> {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    await ensureApplicationDirectories(this.applicationPaths);

    try {
      const rawContent = await readFile(this.applicationPaths.configFilePath, "utf8");
      const parsedConfig = JSON.parse(rawContent) as Partial<AppConfig>;
      this.cachedConfig = sanitizeConfig(parsedConfig, this.applicationPaths);
      this.loadWarning = null;
    } catch (error) {
      this.cachedConfig = createDefaultConfig(this.applicationPaths);

      if (isMissingFileError(error)) {
        this.loadWarning = null;
        await this.persist(this.cachedConfig);
      } else {
        this.loadWarning = createConfigLoadWarning(error, this.applicationPaths.configFilePath);
      }
    }

    return this.cachedConfig;
  }

  /**
   * Merges a partial update into the persisted configuration.
   *
   * @param update Partial configuration updates.
   * @returns The updated persisted configuration.
   */
  public async updateConfig(update: AppConfigUpdate): Promise<AppConfig> {
    const currentConfig = await this.getConfig();
    const nextConfig = sanitizeConfig(
      {
        ...currentConfig,
        ...update,
        customBinaries: update.customBinaries ?? currentConfig.customBinaries,
        debug: {
          ...currentConfig.debug,
          ...update.debug,
        },
      },
      this.applicationPaths,
    );

    await this.persist(nextConfig);
    this.cachedConfig = nextConfig;
    this.loadWarning = null;

    return nextConfig;
  }

  /** Writes the config object to disk as formatted JSON. */
  private async persist(config: AppConfig): Promise<void> {
    await writeFile(this.applicationPaths.configFilePath, JSON.stringify(config, null, 2), "utf8");
  }
}

const MAX_DEBUG_ENTRIES_CEILING = 10_000;

/** Builds a fresh default config using workspace-relative paths. */
function createDefaultConfig(applicationPaths: ApplicationPaths): AppConfig {
  return {
    llamaServerPath: getDefaultWorkspaceLlamaServerPath(applicationPaths),
    modelsPath: getDefaultWorkspaceModelsPath(applicationPaths),
    customBinaries: {},
    theme: "system",
    autoNamingEnabled: true,
    toolEnabledStates: {},
    debug: DEFAULT_DEBUG_SETTINGS,
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function createConfigLoadWarning(error: unknown, configFilePath: string): string {
  const reason = error instanceof Error ? error.message : String(error);

  return [
    `The saved configuration at ${configFilePath} could not be loaded and was left unchanged.`,
    "Temporary defaults are active until you repair the file or save settings again.",
    `Reason: ${reason}`,
  ].join(" ");
}

/** Normalises a partial config by filling missing or invalid fields from defaults. */
function sanitizeConfig(config: Partial<AppConfig>, applicationPaths: ApplicationPaths): AppConfig {
  const defaultConfig = createDefaultConfig(applicationPaths);

  return {
    llamaServerPath:
      typeof config.llamaServerPath === "string"
        ? config.llamaServerPath
        : defaultConfig.llamaServerPath,
    modelsPath:
      typeof config.modelsPath === "string" ? config.modelsPath : defaultConfig.modelsPath,
    customBinaries:
      config.customBinaries && typeof config.customBinaries === "object"
        ? Object.fromEntries(
            Object.entries(config.customBinaries).filter(
              ([binaryName, binaryPath]) => binaryName.length > 0 && typeof binaryPath === "string",
            ),
          )
        : defaultConfig.customBinaries,
    theme:
      config.theme === "light" || config.theme === "dark" || config.theme === "system"
        ? config.theme
        : defaultConfig.theme,
    autoNamingEnabled:
      typeof config.autoNamingEnabled === "boolean"
        ? config.autoNamingEnabled
        : defaultConfig.autoNamingEnabled,
    toolEnabledStates:
      config.toolEnabledStates && typeof config.toolEnabledStates === "object"
        ? Object.fromEntries(
            Object.entries(config.toolEnabledStates).filter(
              ([toolName, enabled]) => toolName.length > 0 && typeof enabled === "boolean",
            ),
          )
        : defaultConfig.toolEnabledStates,
    debug: sanitizeDebugSettings(config.debug, defaultConfig.debug),
  };
}

/** Normalises debug log settings, falling back to defaults for missing or invalid fields. */
function sanitizeDebugSettings(
  debugSettings: Partial<DebugLogSettings> | undefined,
  fallback: DebugLogSettings,
): DebugLogSettings {
  if (!debugSettings) {
    return fallback;
  }

  return {
    enabled: typeof debugSettings.enabled === "boolean" ? debugSettings.enabled : fallback.enabled,
    showProcessStdout:
      typeof debugSettings.showProcessStdout === "boolean"
        ? debugSettings.showProcessStdout
        : fallback.showProcessStdout,
    showProcessStderr:
      typeof debugSettings.showProcessStderr === "boolean"
        ? debugSettings.showProcessStderr
        : fallback.showProcessStderr,
    showServerLogs:
      typeof debugSettings.showServerLogs === "boolean"
        ? debugSettings.showServerLogs
        : fallback.showServerLogs,
    verboseServerLogs:
      typeof debugSettings.verboseServerLogs === "boolean"
        ? debugSettings.verboseServerLogs
        : fallback.verboseServerLogs,
    maxEntries:
      typeof debugSettings.maxEntries === "number" && debugSettings.maxEntries > 0
        ? Math.min(Math.floor(debugSettings.maxEntries), MAX_DEBUG_ENTRIES_CEILING)
        : fallback.maxEntries,
  };
}
