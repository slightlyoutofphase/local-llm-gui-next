"use client";

import { useCallback, useMemo, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { AppConfig, ToolSummary } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

export interface GlobalSettingsProps {
  config: AppConfig | null;
  error: string | null;
  onOpenToolsFolder: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onRefreshTools: () => Promise<void>;
  onSave: (update: Partial<AppConfig>) => Promise<void>;
  open: boolean;
  saving: boolean;
  tools: ToolSummary[];
  toolsLoading: boolean;
}

export interface GlobalSettingsDraft {
  autoNamingEnabled: boolean;
  customBinaries: Array<{ key: string; value: string }>;
  debugEnabled: boolean;
  llamaServerPath: string;
  maxEntries: number;
  modelsPath: string;
  showProcessStderr: boolean;
  showProcessStdout: boolean;
  showServerLogs: boolean;
  theme: AppConfig["theme"];
  toolEnabledStates: Record<string, boolean>;
  verboseServerLogs: boolean;
}

/**
 * Renders the global settings dialog for paths, theme, and debug preferences.
 *
 * @param props Component props.
 * @param props.config The current persisted configuration.
 * @param props.error The latest user-facing save error.
 * @param props.onOpenChange Updates the dialog open state.
 * @param props.onSave Persists a partial configuration update.
 * @param props.open Controls whether the dialog is visible.
 * @param props.saving Indicates whether a save is currently pending.
 * @returns The rendered settings dialog.
 */
export function GlobalSettings({
  config,
  error,
  onOpenToolsFolder,
  onOpenChange,
  onRefreshTools,
  onSave,
  open,
  saving,
  tools,
  toolsLoading,
}: GlobalSettingsProps): ReactElement {
  const persistedDraft = useMemo(() => buildGlobalSettingsDraft(config, tools), [config, tools]);
  const [draft, setDraft] = useState<GlobalSettingsDraft>(() => persistedDraft);
  const [hasUserEditedDraft, setHasUserEditedDraft] = useState(false);
  const currentDraft = resolveGlobalSettingsDraft(persistedDraft, draft, hasUserEditedDraft);

  const refreshDraftFromSnapshot = useCallback((): void => {
    setDraft(persistedDraft);
    setHasUserEditedDraft(false);
  }, [persistedDraft]);

  const updateDraft = useCallback(
    (applyUpdate: (draft: GlobalSettingsDraft) => GlobalSettingsDraft): void => {
      setDraft((currentLocalDraft) =>
        applyUpdate(
          resolveGlobalSettingsDraft(persistedDraft, currentLocalDraft, hasUserEditedDraft),
        ),
      );
      setHasUserEditedDraft(true);
    },
    [hasUserEditedDraft, persistedDraft],
  );

  const persistToolEnabledState = async (toolName: string, checked: boolean): Promise<void> => {
    const nextToolEnabledStates = {
      ...currentDraft.toolEnabledStates,
      [toolName]: checked,
    };
    const nextDraft: GlobalSettingsDraft = {
      ...currentDraft,
      toolEnabledStates: nextToolEnabledStates,
    };

    setDraft(nextDraft);
    setHasUserEditedDraft(true);

    await onSave({
      toolEnabledStates: nextToolEnabledStates,
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    await onSave(buildGlobalSettingsSavePayload(currentDraft));
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen || !open) {
          refreshDraftFromSnapshot();
        }

        onOpenChange(nextOpen);
      }}
      open={open}>
      <DialogContent className="max-w-3xl rounded-[1.5rem] border-border/70 bg-background/95">
        <DialogHeader>
          <DialogTitle>Global settings</DialogTitle>
          <DialogDescription>
            Configure the backend binary paths, UI theme, auto-naming, and debug-log behavior.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-6"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="llama-server-path">llama-server path</Label>
              <Input
                id="llama-server-path"
                onChange={(event) => {
                  updateDraft((currentDraft) => ({
                    ...currentDraft,
                    llamaServerPath: event.target.value,
                  }));
                }}
                placeholder="C:\\path\\to\\llama-server.exe"
                value={currentDraft.llamaServerPath}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="models-path">Models path</Label>
              <Input
                id="models-path"
                onChange={(event) => {
                  updateDraft((currentDraft) => ({
                    ...currentDraft,
                    modelsPath: event.target.value,
                  }));
                }}
                placeholder="C:\\models"
                value={currentDraft.modelsPath}
              />
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Custom binaries</p>
              <p className="text-sm text-muted-foreground">
                Map names to absolute paths for additional executables referenced by tools or
                scripts.
              </p>
            </div>
            {currentDraft.customBinaries.map((entry, index) => (
              <div className="flex items-center gap-2" key={index}>
                <Input
                  onChange={(event) => {
                    updateDraft((currentDraft) => ({
                      ...currentDraft,
                      customBinaries: currentDraft.customBinaries.map((row, i) =>
                        i === index ? { ...row, key: event.target.value } : row,
                      ),
                    }));
                  }}
                  placeholder="name"
                  value={entry.key}
                />
                <Input
                  onChange={(event) => {
                    updateDraft((currentDraft) => ({
                      ...currentDraft,
                      customBinaries: currentDraft.customBinaries.map((row, i) =>
                        i === index ? { ...row, value: event.target.value } : row,
                      ),
                    }));
                  }}
                  placeholder="C:\\path\\to\\binary.exe"
                  value={entry.value}
                />
                <Button
                  onClick={() => {
                    updateDraft((currentDraft) => ({
                      ...currentDraft,
                      customBinaries: currentDraft.customBinaries.filter((_, i) => i !== index),
                    }));
                  }}
                  size="sm"
                  type="button"
                  variant="ghost">
                  Remove
                </Button>
              </div>
            ))}
            <Button
              onClick={() => {
                updateDraft((currentDraft) => ({
                  ...currentDraft,
                  customBinaries: [...currentDraft.customBinaries, { key: "", value: "" }],
                }));
              }}
              size="sm"
              type="button"
              variant="outline">
              Add binary
            </Button>
          </div>

          <Separator />

          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-[1.25rem] border border-border/70 bg-card/80 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Auto-naming</p>
                <p className="text-sm text-muted-foreground">
                  Enable background title generation after the first response.
                </p>
              </div>
              <Switch
                checked={currentDraft.autoNamingEnabled}
                onCheckedChange={(checked) => {
                  updateDraft((currentDraft) => ({
                    ...currentDraft,
                    autoNamingEnabled: checked,
                  }));
                }}
              />
            </div>
            <div className="space-y-3 rounded-[1.25rem] border border-border/70 bg-card/80 p-4">
              <p className="text-sm font-medium">Theme</p>
              <div className="flex flex-wrap gap-2">
                {(["light", "dark", "system"] as const).map((themeValue) => (
                  <Button
                    key={themeValue}
                    onClick={() => {
                      updateDraft((currentDraft) => ({
                        ...currentDraft,
                        theme: themeValue,
                      }));
                    }}
                    type="button"
                    variant={currentDraft.theme === themeValue ? "default" : "outline"}>
                    {themeValue}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <Separator />

          <div className="space-y-4 rounded-[1.25rem] border border-border/70 bg-card/80 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Debug log</p>
                <p className="text-sm text-muted-foreground">
                  Control which backend streams remain visible in the debug panel and whether send
                  requests emit deeper backend tracing.
                </p>
              </div>
              <Switch
                checked={currentDraft.debugEnabled}
                onCheckedChange={(checked) => {
                  updateDraft((currentDraft) => ({
                    ...currentDraft,
                    debugEnabled: checked,
                  }));
                }}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <ToggleRow
                checked={currentDraft.showProcessStdout}
                label="llama-server stdout"
                onCheckedChange={(checked) => {
                  updateDraft((currentDraft) => ({
                    ...currentDraft,
                    showProcessStdout: checked,
                  }));
                }}
              />
              <ToggleRow
                checked={currentDraft.showProcessStderr}
                label="llama-server stderr"
                onCheckedChange={(checked) => {
                  updateDraft((currentDraft) => ({
                    ...currentDraft,
                    showProcessStderr: checked,
                  }));
                }}
              />
              <ToggleRow
                checked={currentDraft.showServerLogs}
                label="Server logs"
                onCheckedChange={(checked) => {
                  updateDraft((currentDraft) => ({
                    ...currentDraft,
                    showServerLogs: checked,
                  }));
                }}
              />
              <ToggleRow
                checked={currentDraft.verboseServerLogs}
                label="Verbose server logs"
                onCheckedChange={(checked) => {
                  updateDraft((currentDraft) => ({
                    ...currentDraft,
                    verboseServerLogs: checked,
                  }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="max-log-entries">Max log entries</Label>
              <Input
                id="max-log-entries"
                min={50}
                onChange={(event) => {
                  updateDraft((currentDraft) => ({
                    ...currentDraft,
                    maxEntries: Number(event.target.value) || 1000,
                  }));
                }}
                type="number"
                value={currentDraft.maxEntries}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-4 rounded-[1.25rem] border border-border/70 bg-card/80 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Tool manager</p>
                <p className="text-sm text-muted-foreground">
                  Review discovered local tools, inspect load errors, and persist enablement.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    void onOpenToolsFolder();
                  }}
                  type="button"
                  variant="outline">
                  Open tools folder
                </Button>
                <Button
                  onClick={() => {
                    void onRefreshTools();
                  }}
                  type="button"
                  variant="outline">
                  {toolsLoading ? "Refreshing..." : "Refresh tools"}
                </Button>
              </div>
            </div>

            {tools.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 bg-background/80 px-4 py-3 text-sm text-muted-foreground">
                No tools are currently discovered. Add a `tool.ts` plugin under the app-data tools
                directory and refresh.
              </div>
            ) : (
              <div className="space-y-3">
                {tools.map((tool) => {
                  const enabled = currentDraft.toolEnabledStates[tool.name] ?? tool.enabled;

                  return (
                    <div
                      className="space-y-3 rounded-2xl border border-border/70 bg-background/80 px-4 py-3"
                      key={`${tool.source}-${tool.name}`}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{tool.displayName ?? tool.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {tool.source} · {tool.loadStatus}
                          </p>
                        </div>
                        <Switch
                          checked={enabled}
                          disabled={saving || tool.loadStatus !== "loaded"}
                          onCheckedChange={(checked) => {
                            void persistToolEnabledState(tool.name, checked);
                          }}
                        />
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {tool.description || "No description."}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        category: {tool.policy.category} · dangerous:{" "}
                        {tool.policy.dangerous ? "yes" : "no"} · confirmation:{" "}
                        {tool.policy.requiresConfirmation ? "yes" : "no"}
                      </p>
                      {tool.sourcePath ? (
                        <p className="break-all text-xs text-muted-foreground">{tool.sourcePath}</p>
                      ) : null}
                      {tool.error ? <p className="text-sm text-destructive">{tool.error}</p> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Close
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? "Saving..." : "Save settings"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Builds a mutable settings draft from the persisted config and discovered tools.
 */
export function buildGlobalSettingsDraft(
  config: AppConfig | null,
  tools: ToolSummary[],
): GlobalSettingsDraft {
  return {
    autoNamingEnabled: config?.autoNamingEnabled ?? true,
    customBinaries: Object.entries(config?.customBinaries ?? {}).map(([key, value]) => ({
      key,
      value,
    })),
    debugEnabled: config?.debug.enabled ?? true,
    llamaServerPath: config?.llamaServerPath ?? "",
    maxEntries: config?.debug.maxEntries ?? 1000,
    modelsPath: config?.modelsPath ?? "",
    showProcessStderr: config?.debug.showProcessStderr ?? true,
    showProcessStdout: config?.debug.showProcessStdout ?? true,
    showServerLogs: config?.debug.showServerLogs ?? true,
    theme: config?.theme ?? "system",
    toolEnabledStates: buildToolEnabledStates(config, tools),
    verboseServerLogs: config?.debug.verboseServerLogs ?? false,
  };
}

export function resolveGlobalSettingsDraft(
  persistedDraft: GlobalSettingsDraft,
  localDraft: GlobalSettingsDraft,
  hasUserEditedDraft: boolean,
): GlobalSettingsDraft {
  return hasUserEditedDraft ? localDraft : persistedDraft;
}

/**
 * Converts a mutable settings draft back into the persisted config payload shape.
 */
export function buildGlobalSettingsSavePayload(draft: GlobalSettingsDraft): Partial<AppConfig> {
  return {
    autoNamingEnabled: draft.autoNamingEnabled,
    customBinaries: Object.fromEntries(
      draft.customBinaries
        .filter((entry) => entry.key.trim().length > 0)
        .map((entry) => [entry.key.trim(), entry.value.trim()]),
    ),
    debug: {
      enabled: draft.debugEnabled,
      maxEntries: draft.maxEntries,
      showProcessStderr: draft.showProcessStderr,
      showProcessStdout: draft.showProcessStdout,
      showServerLogs: draft.showServerLogs,
      verboseServerLogs: draft.verboseServerLogs,
    },
    llamaServerPath: draft.llamaServerPath,
    modelsPath: draft.modelsPath,
    theme: draft.theme,
    toolEnabledStates: draft.toolEnabledStates,
  };
}

/**
 * Builds the initial tool enabled-state map from persisted config and discovered tools.
 *
 * @param config The current application configuration.
 * @param tools The discovered tool summaries.
 * @returns A record keyed by tool name with boolean enabled values.
 */
export function buildToolEnabledStates(
  config: AppConfig | null,
  tools: ToolSummary[],
): Record<string, boolean> {
  const nextToolEnabledStates: Record<string, boolean> = {
    ...(config?.toolEnabledStates ?? {}),
  };

  for (const tool of tools) {
    if (tool.loadStatus === "loaded" && !(tool.name in nextToolEnabledStates)) {
      nextToolEnabledStates[tool.name] = tool.enabled;
    }
  }

  return nextToolEnabledStates;
}

interface ToggleRowProps {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}

/** Renders a labeled toggle row with a switch control. */
function ToggleRow({ checked, label, onCheckedChange }: ToggleRowProps): ReactElement {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-background/80 px-4 py-3">
      <Label>{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
