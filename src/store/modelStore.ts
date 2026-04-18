import { create } from "zustand";
import type {
  AppConfig,
  LoadInferencePreset,
  ModelRecord,
  RuntimeSnapshot,
  SystemPromptPreset,
  ToolSummary,
} from "../lib/contracts";
import {
  createLoadInferencePreset as createLoadInferencePresetRequest,
  createSystemPromptPreset as createSystemPromptPresetRequest,
  deleteLoadInferencePreset as deleteLoadInferencePresetRequest,
  deleteSystemPromptPreset as deleteSystemPromptPresetRequest,
  getConfig,
  getLoadInferencePresets,
  getModels,
  getRuntimeSnapshot,
  getSystemPromptPresets,
  getTools,
  loadModel as loadModelRequest,
  openModelsFolder as openModelsFolderRequest,
  openToolsFolder as openToolsFolderRequest,
  refreshTools as refreshToolsRequest,
  setDefaultLoadInferencePreset as setDefaultLoadInferencePresetRequest,
  setDefaultSystemPromptPreset as setDefaultSystemPromptPresetRequest,
  subscribeToJsonSse,
  unloadModel as unloadModelRequest,
  updateLoadInferencePreset as updateLoadInferencePresetRequest,
  updateSystemPromptPreset as updateSystemPromptPresetRequest,
  updateConfig,
} from "../lib/api";
import {
  buildRuntimeLoadFailureSnapshot,
  calculateRuntimeLoadTimeoutMs,
  shouldStartRuntimeLoadPolling,
} from "../lib/runtimeLoad";
import {
  invalidateUiCacheForRevisionBestEffort,
  readUiCacheBestEffort,
  type UiCacheState,
  writeUiCacheBestEffort,
} from "../lib/ui-cache";

let disconnectRuntimeStream: (() => void) | null = null;
let shouldReconnectRuntimeStream = false;
const configSaveQueue = createSerialTaskQueue();

export interface SerialTaskQueue {
  enqueue: <TResult>(task: () => Promise<TResult>) => Promise<TResult>;
  hasPendingTasks: () => boolean;
}

/**
 * Creates a FIFO async task queue so settings writes cannot race each other.
 */
export function createSerialTaskQueue(): SerialTaskQueue {
  let pendingTasks = 0;
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue: <TResult>(task: () => Promise<TResult>): Promise<TResult> => {
      pendingTasks += 1;

      const runTask = async (): Promise<TResult> => {
        try {
          return await task();
        } finally {
          pendingTasks -= 1;
        }
      };

      const queuedTask = tail.then(runTask, runTask);

      tail = queuedTask.then(
        () => undefined,
        () => undefined,
      );

      return queuedTask;
    },
    hasPendingTasks: (): boolean => pendingTasks > 0,
  };
}

/**
 * Represents the frontend model and runtime store state.
 */
export interface ModelStoreState {
  /** The persisted application config. */
  config: AppConfig | null;
  /** The scanned GGUF model records. */
  models: ModelRecord[];
  /** The current managed runtime snapshot. */
  runtime: RuntimeSnapshot | null;
  /** The discovered built-in and local tools. */
  tools: ToolSummary[];
  /** Model-scoped system prompt presets. */
  systemPromptPresetsByModelId: Record<string, SystemPromptPreset[]>;
  /** Model-scoped load and inference presets. */
  loadInferencePresetsByModelId: Record<string, LoadInferencePreset[]>;
  /** The currently selected model identifier. */
  selectedModelId: string | null;
  /** The selected system-prompt preset per model. */
  selectedSystemPromptPresetIds: Record<string, string>;
  /** The selected load preset per model. */
  selectedLoadPresetIds: Record<string, string>;
  /** Internal token for the latest in-flight runtime operation. */
  activeRuntimeOperationToken: number;
  /** Indicates whether the store completed initial hydration. */
  hydrated: boolean;
  /** Indicates whether model scanning is in progress. */
  modelsLoading: boolean;
  /** Optional warning describing a failed model-library scan. */
  modelsWarning: string | null;
  /** Indicates whether tool discovery is in progress. */
  toolsLoading: boolean;
  /** Indicates whether preset persistence is in progress. */
  presetsSaving: boolean;
  /** Indicates whether config persistence is in progress. */
  savingConfig: boolean;
  /** The latest user-facing store error, if any. */
  error: string | null;
  /** The latest backend revision reflected in the model store. */
  knownDbRevision: number;
  /** Explicit message for the most recent failed model-load attempt, when present. */
  runtimeLoadFailure: string | null;
  /** Visible warning when live runtime updates have degraded after reconnect exhaustion. */
  runtimeStreamWarning: string | null;
  /** Hydrates config, runtime, cached models, and default presets. */
  hydrate: () => Promise<void>;
  /** Refreshes the current model list from the backend. */
  refreshModels: () => Promise<void>;
  /** Refreshes the current discovered tool list from the backend. */
  refreshTools: () => Promise<void>;
  /** Selects a model and loads its presets. */
  selectModel: (modelId: string | null) => Promise<void>;
  /** Selects the active system-prompt preset for a model. */
  selectSystemPromptPreset: (modelId: string, presetId: string) => void;
  /** Selects the active load preset for a model. */
  selectLoadPreset: (modelId: string, presetId: string) => void;
  /** Loads the selected model into the managed runtime. */
  loadModel: (modelId: string) => Promise<void>;
  /** Unloads the currently active model. */
  unloadModel: () => Promise<void>;
  /** Creates a new system-prompt preset. */
  createSystemPromptPreset: (
    modelId: string,
    input: {
      jinjaTemplateOverride?: string;
      name: string;
      systemPrompt: string;
      thinkingTags: SystemPromptPreset["thinkingTags"];
    },
  ) => Promise<SystemPromptPreset | null>;
  /** Updates an existing system-prompt preset. */
  updateSystemPromptPreset: (
    presetId: string,
    input: {
      jinjaTemplateOverride?: string;
      name: string;
      systemPrompt: string;
      thinkingTags: SystemPromptPreset["thinkingTags"];
    },
  ) => Promise<SystemPromptPreset | null>;
  /** Deletes an existing system-prompt preset. */
  deleteSystemPromptPreset: (modelId: string, presetId: string) => Promise<void>;
  /** Marks a system-prompt preset as default. */
  setDefaultSystemPromptPreset: (modelId: string, presetId: string) => Promise<void>;
  /** Creates a new load and inference preset. */
  createLoadInferencePreset: (
    modelId: string,
    input: {
      name: string;
      settings: LoadInferencePreset["settings"];
    },
  ) => Promise<LoadInferencePreset | null>;
  /** Updates an existing load and inference preset. */
  updateLoadInferencePreset: (
    presetId: string,
    input: {
      name: string;
      settings: LoadInferencePreset["settings"];
    },
  ) => Promise<LoadInferencePreset | null>;
  /** Deletes an existing load and inference preset. */
  deleteLoadInferencePreset: (modelId: string, presetId: string) => Promise<void>;
  /** Marks a load and inference preset as default. */
  setDefaultLoadInferencePreset: (modelId: string, presetId: string) => Promise<void>;
  /** Persists a partial configuration update. */
  saveConfig: (update: Partial<AppConfig>) => Promise<void>;
  /** Opens the local tools folder in the OS file explorer. */
  openToolsFolder: () => Promise<void>;
  /** Opens the configured models folder in the OS file explorer. */
  openModelsFolder: () => Promise<void>;
  /** Opens the runtime SSE connection when it is not already active. */
  connectRuntimeStream: () => void;
  /** Closes the runtime SSE connection. */
  disconnectRuntimeStream: () => void;
  /** Reconciles the local model state against an externally updated UI-cache snapshot. */
  synchronizeFromUiCache: (uiCache: UiCacheState) => Promise<void>;
}

/**
 * Provides the frontend runtime and model-management Zustand store.
 */
export const useModelStore = create<ModelStoreState>((set, get) => ({
  config: null,
  models: [],
  runtime: null,
  tools: [],
  systemPromptPresetsByModelId: {},
  loadInferencePresetsByModelId: {},
  selectedModelId: null,
  selectedSystemPromptPresetIds: {},
  selectedLoadPresetIds: {},
  activeRuntimeOperationToken: 0,
  hydrated: false,
  modelsLoading: false,
  modelsWarning: null,
  toolsLoading: false,
  presetsSaving: false,
  savingConfig: false,
  error: null,
  knownDbRevision: 0,
  runtimeLoadFailure: null,
  runtimeStreamWarning: null,
  hydrate: async () => {
    try {
      const uiCache = await readUiCacheBestEffort();

      if (uiCache.cachedModels.length > 0) {
        set({ models: uiCache.cachedModels });
      }

      const [configResponse, runtimeSnapshot, modelResponse, toolResponse] = await Promise.all([
        getConfig(),
        getRuntimeSnapshot(),
        getModels(),
        getTools(),
      ]);

      // Force a full page reload when the backend has restarted with a different
      // build ID, preventing stale JS chunk references after binary upgrades (S2).
      if (
        configResponse.buildId &&
        uiCache.lastBuildId &&
        configResponse.buildId !== uiCache.lastBuildId
      ) {
        await writeUiCacheBestEffort({ lastBuildId: configResponse.buildId });
        window.location.reload();
        return;
      }

      const normalizedUiCache = await invalidateUiCacheForRevisionBestEffort(
        uiCache,
        modelResponse.dbRevision,
      );
      await writeUiCacheBestEffort(
        {
          cachedModels: modelResponse.models,
          dbRevision: modelResponse.dbRevision,
          lastBuildId: configResponse.buildId ?? uiCache.lastBuildId,
        },
        {
          currentCache: normalizedUiCache,
        },
      );

      const selectedModelId = runtimeSnapshot.activeModelId ?? modelResponse.models[0]?.id ?? null;

      set({
        config: configResponse.config,
        error: configResponse.warning ?? null,
        hydrated: true,
        knownDbRevision: modelResponse.dbRevision,
        models: modelResponse.models,
        modelsWarning: modelResponse.warning ?? null,
        runtime: runtimeSnapshot,
        runtimeLoadFailure: null,
        selectedModelId,
        tools: toolResponse.tools,
      });

      if (selectedModelId) {
        await loadPresetsForModel(selectedModelId, set, get);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to hydrate the model store.",
        hydrated: true,
      });
    }
  },
  refreshModels: async () => {
    set({ error: null, modelsLoading: true, modelsWarning: null });

    try {
      const uiCache = await readUiCacheBestEffort();
      const modelResponse = await getModels();
      const currentSelection = get().selectedModelId;
      const nextSelection = modelResponse.models.some((model) => model.id === currentSelection)
        ? currentSelection
        : (modelResponse.models[0]?.id ?? null);

      const normalizedUiCache = await invalidateUiCacheForRevisionBestEffort(
        uiCache,
        modelResponse.dbRevision,
      );
      await writeUiCacheBestEffort(
        {
          cachedModels: modelResponse.models,
          dbRevision: modelResponse.dbRevision,
        },
        {
          currentCache: normalizedUiCache,
        },
      );

      set({
        error: null,
        knownDbRevision: modelResponse.dbRevision,
        models: modelResponse.models,
        modelsLoading: false,
        modelsWarning: modelResponse.warning ?? null,
        selectedModelId: nextSelection,
      });

      if (nextSelection) {
        await loadPresetsForModel(nextSelection, set, get);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to refresh models.",
        modelsLoading: false,
        modelsWarning: null,
      });
    }
  },
  refreshTools: async () => {
    set({ error: null, toolsLoading: true });

    try {
      const toolResponse = await refreshToolsRequest();

      set({
        error: null,
        tools: toolResponse.tools,
        toolsLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to refresh tools.",
        toolsLoading: false,
      });
    }
  },
  selectModel: async (modelId) => {
    set({ error: null, selectedModelId: modelId });

    if (modelId) {
      try {
        await loadPresetsForModel(modelId, set, get);
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : "Failed to load model presets.",
        });
      }
    }
  },
  selectSystemPromptPreset: (modelId, presetId) => {
    set((state) => ({
      selectedSystemPromptPresetIds: {
        ...state.selectedSystemPromptPresetIds,
        [modelId]: presetId,
      },
    }));
  },
  selectLoadPreset: (modelId, presetId) => {
    set((state) => ({
      selectedLoadPresetIds: {
        ...state.selectedLoadPresetIds,
        [modelId]: presetId,
      },
    }));
  },
  loadModel: async (modelId) => {
    if (get().presetsSaving) {
      set({ error: "Cannot load a model while presets are being saved. Please wait." });
      return;
    }

    const operationToken = beginRuntimeOperation(set);

    try {
      await loadPresetsForModel(modelId, set, get);
    } catch (error) {
      if (!isCurrentRuntimeOperation(operationToken, get)) {
        return;
      }

      set({
        error: error instanceof Error ? error.message : "Failed to load model presets.",
      });
      return;
    }

    if (!isCurrentRuntimeOperation(operationToken, get)) {
      return;
    }

    await runLoadModelRequest(modelId, set, get, operationToken);
  },
  unloadModel: async () => {
    const operationToken = beginRuntimeOperation(set);

    try {
      const runtimeSnapshot = await unloadModelRequest();

      if (!isCurrentRuntimeOperation(operationToken, get)) {
        return;
      }

      set({
        error: null,
        runtime: runtimeSnapshot,
        runtimeLoadFailure: null,
      });
    } catch (error) {
      if (!isCurrentRuntimeOperation(operationToken, get)) {
        return;
      }

      const runtimeSnapshot = await safeGetRuntimeSnapshot();

      if (!isCurrentRuntimeOperation(operationToken, get)) {
        return;
      }

      set({
        error: error instanceof Error ? error.message : "Failed to unload the model.",
        runtime: runtimeSnapshot ?? get().runtime,
        runtimeLoadFailure: null,
      });
    }
  },
  createSystemPromptPreset: async (modelId, input) => {
    set({ error: null, presetsSaving: true });

    try {
      const response = await createSystemPromptPresetRequest(modelId, input);

      set((state) => ({
        selectedSystemPromptPresetIds: {
          ...state.selectedSystemPromptPresetIds,
          [modelId]: response.preset.id,
        },
      }));
      await loadPresetsForModel(modelId, set, get, true);
      set({ presetsSaving: false });

      return response.preset;
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to create the system prompt preset.",
        presetsSaving: false,
      });

      return null;
    }
  },
  updateSystemPromptPreset: async (presetId, input) => {
    set({ error: null, presetsSaving: true });

    try {
      const response = await updateSystemPromptPresetRequest(presetId, input);

      await loadPresetsForModel(response.preset.modelId, set, get, true);
      await maybeReloadActiveModel(response.preset.modelId, get, set, {
        kind: "system",
        presetId,
      });
      set({ presetsSaving: false });

      return response.preset;
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to update the system prompt preset.",
        presetsSaving: false,
      });

      return null;
    }
  },
  deleteSystemPromptPreset: async (modelId, presetId) => {
    set({ error: null, presetsSaving: true });

    try {
      const response = await deleteSystemPromptPresetRequest(presetId);

      set((state) => ({
        selectedSystemPromptPresetIds:
          state.selectedSystemPromptPresetIds[modelId] === presetId
            ? {
                ...state.selectedSystemPromptPresetIds,
                ...(response.promotedDefaultId ? { [modelId]: response.promotedDefaultId } : {}),
              }
            : state.selectedSystemPromptPresetIds,
      }));
      await loadPresetsForModel(modelId, set, get, true);
      await maybeReloadActiveModel(modelId, get, set, {
        kind: "system",
        presetId,
      });
      set({ presetsSaving: false });
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to delete the system prompt preset.",
        presetsSaving: false,
      });
    }
  },
  setDefaultSystemPromptPreset: async (modelId, presetId) => {
    set({ error: null, presetsSaving: true });

    try {
      await setDefaultSystemPromptPresetRequest(presetId);
      await loadPresetsForModel(modelId, set, get, true);
      set({ presetsSaving: false });
    } catch (error) {
      set({
        error:
          error instanceof Error
            ? error.message
            : "Failed to set the default system prompt preset.",
        presetsSaving: false,
      });
    }
  },
  createLoadInferencePreset: async (modelId, input) => {
    set({ error: null, presetsSaving: true });

    try {
      const response = await createLoadInferencePresetRequest(modelId, input);

      set((state) => ({
        selectedLoadPresetIds: {
          ...state.selectedLoadPresetIds,
          [modelId]: response.preset.id,
        },
      }));
      await loadPresetsForModel(modelId, set, get, true);
      set({ presetsSaving: false });

      return response.preset;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to create the load preset.",
        presetsSaving: false,
      });

      return null;
    }
  },
  updateLoadInferencePreset: async (presetId, input) => {
    set({ error: null, presetsSaving: true });

    try {
      const response = await updateLoadInferencePresetRequest(presetId, input);

      await loadPresetsForModel(response.preset.modelId, set, get, true);
      await maybeReloadActiveModel(response.preset.modelId, get, set, {
        kind: "load",
        presetId,
      });
      set({ presetsSaving: false });

      return response.preset;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to update the load preset.",
        presetsSaving: false,
      });

      return null;
    }
  },
  deleteLoadInferencePreset: async (modelId, presetId) => {
    set({ error: null, presetsSaving: true });

    try {
      const response = await deleteLoadInferencePresetRequest(presetId);

      set((state) => ({
        selectedLoadPresetIds:
          state.selectedLoadPresetIds[modelId] === presetId
            ? {
                ...state.selectedLoadPresetIds,
                ...(response.promotedDefaultId ? { [modelId]: response.promotedDefaultId } : {}),
              }
            : state.selectedLoadPresetIds,
      }));
      await loadPresetsForModel(modelId, set, get, true);
      await maybeReloadActiveModel(modelId, get, set, {
        kind: "load",
        presetId,
      });
      set({ presetsSaving: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete the load preset.",
        presetsSaving: false,
      });
    }
  },
  setDefaultLoadInferencePreset: async (modelId, presetId) => {
    set({ error: null, presetsSaving: true });

    try {
      await setDefaultLoadInferencePresetRequest(presetId);
      await loadPresetsForModel(modelId, set, get, true);
      set({ presetsSaving: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to set the default load preset.",
        presetsSaving: false,
      });
    }
  },
  saveConfig: async (update) => {
    set({ error: null, savingConfig: true });

    try {
      await configSaveQueue.enqueue(async () => {
        let currentUpdate = update;
        let attempt = 0;

        while (attempt < 3) {
          attempt += 1;
          const configResponse = await updateConfig(currentUpdate, get().config?.configRevision);

          if (configResponse.error) {
            set({ config: configResponse.config });

            currentUpdate = {
              ...currentUpdate,
              customBinaries: currentUpdate.customBinaries ?? configResponse.config.customBinaries,
              debug: {
                ...configResponse.config.debug,
                ...currentUpdate.debug,
              },
            };

            continue;
          }

          set({
            config: configResponse.config,
            error: configResponse.warning ?? null,
          });

          if (typeof update.modelsPath === "string") {
            await get().refreshModels();
          }

          if (update.toolEnabledStates) {
            await get().refreshTools();
          }

          break;
        }

        if (attempt >= 3) {
          throw new Error("Failed to save configuration after multiple concurrent updates.");
        }
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to save configuration.",
      });
    } finally {
      set({ savingConfig: configSaveQueue.hasPendingTasks() });
    }
  },
  openToolsFolder: async () => {
    try {
      await openToolsFolderRequest();
      set({ error: null });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to open the tools folder.",
      });
    }
  },
  openModelsFolder: async () => {
    try {
      await openModelsFolderRequest();
      set({ error: null });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to open the models folder.",
      });
    }
  },
  connectRuntimeStream: () => {
    shouldReconnectRuntimeStream = true;
    set({ runtimeStreamWarning: null });
    establishRuntimeStreamSubscription(set, get);
  },
  disconnectRuntimeStream: () => {
    shouldReconnectRuntimeStream = false;

    disconnectRuntimeStream?.();
    disconnectRuntimeStream = null;
    set({ runtimeStreamWarning: null });
  },
  synchronizeFromUiCache: async (uiCache) => {
    const currentState = get();

    if (!currentState.hydrated || uiCache.dbRevision <= currentState.knownDbRevision) {
      return;
    }

    const nextModels = uiCache.cachedModels;
    const nextSelectedModelId = nextModels.some(
      (model) => model.id === currentState.selectedModelId,
    )
      ? currentState.selectedModelId
      : (currentState.runtime?.activeModelId ?? nextModels[0]?.id ?? null);

    set({
      knownDbRevision: uiCache.dbRevision,
      models: nextModels,
      modelsWarning: null,
      selectedModelId: nextSelectedModelId,
    });

    if (nextSelectedModelId) {
      try {
        await loadPresetsForModel(nextSelectedModelId, set, get);
      } catch {
        // Keep external sync best-effort so window activation cannot break the shell.
      }
    }
  },
}));

function establishRuntimeStreamSubscription(
  setState: typeof useModelStore.setState,
  getState: typeof useModelStore.getState,
): void {
  if (!shouldReconnectRuntimeStream || disconnectRuntimeStream) {
    return;
  }

  disconnectRuntimeStream = subscribeToJsonSse<RuntimeSnapshot>(
    "/api/events/runtime",
    "runtime",
    (runtimeSnapshot) => {
      setState({
        runtime: runtimeSnapshot,
        runtimeLoadFailure:
          runtimeSnapshot.status === "idle" || runtimeSnapshot.status === "ready"
            ? null
            : getState().runtimeLoadFailure,
        runtimeStreamWarning: null,
        selectedModelId: runtimeSnapshot.activeModelId ?? getState().selectedModelId,
      });
    },
    {
      onError: (error) => {
        if (error.kind === "fatal") {
          setState({
            runtimeStreamWarning:
              error.error?.message ??
              "Live runtime updates are unavailable because the runtime event stream could not recover.",
          });
          disconnectRuntimeStream = null;
        }
      },
      onOpen: () => {
        setState({ runtimeStreamWarning: null });

        // Fetch the current runtime snapshot on every SSE connect/reconnect to
        // ensure the frontend state is consistent even when the ring buffer has
        // cycled past critical events during a disconnect (C1 remediation).
        void safeGetRuntimeSnapshot().then((runtimeSnapshot) => {
          if (
            runtimeSnapshot &&
            shouldReplaceRuntimeSnapshot(getState().runtime, runtimeSnapshot)
          ) {
            setState({
              runtime: runtimeSnapshot,
              runtimeLoadFailure:
                runtimeSnapshot.status === "idle" || runtimeSnapshot.status === "ready"
                  ? null
                  : getState().runtimeLoadFailure,
              selectedModelId: runtimeSnapshot.activeModelId ?? getState().selectedModelId,
            });
          }
        });
      },
      reconnect: {
        initialDelayMs: 1_500,
        maxAttempts: 5,
        maxDelayMs: 10_000,
      },
    },
  );
}

/** Fetches and caches system-prompt and load presets for a model. */
async function loadPresetsForModel(
  modelId: string,
  setState: typeof useModelStore.setState,
  getState: typeof useModelStore.getState,
  forceReload = false,
): Promise<void> {
  const currentState = getState();

  if (
    !forceReload &&
    currentState.systemPromptPresetsByModelId[modelId] &&
    currentState.loadInferencePresetsByModelId[modelId]
  ) {
    return;
  }

  const [systemPromptResponse, loadPresetResponse] = await Promise.all([
    getSystemPromptPresets(modelId),
    getLoadInferencePresets(modelId),
  ]);

  const currentSelectedSystemPromptPresetId = currentState.selectedSystemPromptPresetIds[modelId];
  const currentSelectedLoadPresetId = currentState.selectedLoadPresetIds[modelId];
  const selectedSystemPromptPresetId = systemPromptResponse.presets.some(
    (preset) => preset.id === currentSelectedSystemPromptPresetId,
  )
    ? currentSelectedSystemPromptPresetId
    : (systemPromptResponse.presets.find((preset) => preset.isDefault)?.id ??
      systemPromptResponse.presets[0]?.id);
  const selectedLoadPresetId = loadPresetResponse.presets.some(
    (preset) => preset.id === currentSelectedLoadPresetId,
  )
    ? currentSelectedLoadPresetId
    : (loadPresetResponse.presets.find((preset) => preset.isDefault)?.id ??
      loadPresetResponse.presets[0]?.id);

  setState((state) => ({
    loadInferencePresetsByModelId: {
      ...state.loadInferencePresetsByModelId,
      [modelId]: loadPresetResponse.presets,
    },
    selectedLoadPresetIds: selectedLoadPresetId
      ? {
          ...state.selectedLoadPresetIds,
          [modelId]: selectedLoadPresetId,
        }
      : state.selectedLoadPresetIds,
    selectedSystemPromptPresetIds: selectedSystemPromptPresetId
      ? {
          ...state.selectedSystemPromptPresetIds,
          [modelId]: selectedSystemPromptPresetId,
        }
      : state.selectedSystemPromptPresetIds,
    systemPromptPresetsByModelId: {
      ...state.systemPromptPresetsByModelId,
      [modelId]: systemPromptResponse.presets,
    },
  }));
}

/** Reloads the active runtime if the changed preset is currently selected. */
async function maybeReloadActiveModel(
  modelId: string,
  getState: typeof useModelStore.getState,
  setState: typeof useModelStore.setState,
  changedPreset: {
    kind: "load" | "system";
    presetId: string;
  },
): Promise<void> {
  const currentState = getState();
  const selectedSystemPromptPresetId = currentState.selectedSystemPromptPresetIds[modelId];
  const selectedLoadPresetId = currentState.selectedLoadPresetIds[modelId];
  const shouldReload =
    currentState.runtime?.activeModelId === modelId &&
    ((changedPreset.kind === "system" && selectedSystemPromptPresetId === changedPreset.presetId) ||
      (changedPreset.kind === "load" && selectedLoadPresetId === changedPreset.presetId));

  if (!shouldReload) {
    return;
  }

  await runLoadModelRequest(modelId, setState, getState);
}

function beginRuntimeOperation(setState: typeof useModelStore.setState): number {
  let nextOperationToken = 0;

  setState((state) => {
    nextOperationToken = state.activeRuntimeOperationToken + 1;

    return {
      activeRuntimeOperationToken: nextOperationToken,
      runtimeLoadFailure: null,
    };
  });

  return nextOperationToken;
}

function isCurrentRuntimeOperation(
  operationToken: number,
  getState: typeof useModelStore.getState,
): boolean {
  return getState().activeRuntimeOperationToken === operationToken;
}

async function runLoadModelRequest(
  modelId: string,
  setState: typeof useModelStore.setState,
  getState: typeof useModelStore.getState,
  operationToken = beginRuntimeOperation(setState),
): Promise<void> {
  const currentState = getState();
  const selectedLoadPresetId = currentState.selectedLoadPresetIds[modelId];
  const selectedSystemPromptPresetId = currentState.selectedSystemPromptPresetIds[modelId];
  const selectedModel = currentState.models.find((model) => model.id === modelId) ?? null;
  const selectedLoadPreset =
    currentState.loadInferencePresetsByModelId[modelId]?.find(
      (preset) => preset.id === selectedLoadPresetId,
    ) ??
    currentState.loadInferencePresetsByModelId[modelId]?.[0] ??
    null;

  if (selectedModel) {
    setState({
      error: null,
      runtime: createLoadingRuntimeSnapshot(selectedModel, selectedLoadPreset),
      runtimeLoadFailure: null,
      selectedModelId: modelId,
    });
  } else {
    setState({ error: null, runtimeLoadFailure: null, selectedModelId: modelId });
  }

  const stopPolling = shouldStartRuntimeLoadPolling(disconnectRuntimeStream !== null)
    ? startRuntimeLoadPolling(operationToken, setState, getState)
    : () => {};
  const timeoutMs = calculateRuntimeLoadTimeoutMs({
    contextLength:
      selectedLoadPreset?.settings.contextLength ?? selectedModel?.contextLength ?? null,
    fileSizeBytes: selectedModel?.fileSizeBytes ?? null,
  });

  try {
    const runtimeSnapshot = await loadModelRequest(
      modelId,
      selectedLoadPresetId,
      selectedSystemPromptPresetId,
      timeoutMs,
    );

    if (!isCurrentRuntimeOperation(operationToken, getState)) {
      return;
    }

    setState({
      error: null,
      runtime: runtimeSnapshot,
      selectedModelId: modelId,
    });
  } catch (error) {
    if (!isCurrentRuntimeOperation(operationToken, getState)) {
      return;
    }

    const fallbackMessage = error instanceof Error ? error.message : "Failed to load the model.";
    const runtimeSnapshot = await safeGetRuntimeSnapshot();

    if (!isCurrentRuntimeOperation(operationToken, getState)) {
      return;
    }

    const recoveredRuntime = runtimeSnapshot?.status === "ready" ? runtimeSnapshot : null;
    const runtimeErrorMessage =
      runtimeSnapshot?.status === "error" && runtimeSnapshot.lastError
        ? runtimeSnapshot.lastError
        : fallbackMessage;
    const nextRuntime =
      recoveredRuntime ??
      (runtimeSnapshot?.status === "error" && runtimeSnapshot.lastError
        ? runtimeSnapshot
        : buildRuntimeLoadFailureSnapshot({
            errorMessage: runtimeErrorMessage,
            loadPreset: selectedLoadPreset,
            model: selectedModel,
            previousRuntime: getState().runtime,
          }));

    setState({
      error: null,
      runtime: nextRuntime,
      runtimeLoadFailure: recoveredRuntime ? null : runtimeErrorMessage,
      selectedModelId: modelId,
    });
  } finally {
    stopPolling();
  }
}

function createLoadingRuntimeSnapshot(
  model: ModelRecord,
  loadPreset: LoadInferencePreset | null,
): RuntimeSnapshot {
  return {
    activeModelId: model.id,
    activeModelPath: model.modelPath,
    audio: model.supportsAudio,
    contextLimitTokens: loadPreset?.settings.contextLength ?? model.contextLength ?? null,
    contextTokens: null,
    lastError: null,
    llamaServerBaseUrl: null,
    loadProgress: 0,
    multimodal: Boolean(model.mmprojPath) || model.supportsAudio,
    status: "loading",
    tokensPerSecond: null,
    updatedAt: new Date().toISOString(),
  };
}

function startRuntimeLoadPolling(
  operationToken: number,
  setState: typeof useModelStore.setState,
  getState: typeof useModelStore.getState,
): () => void {
  let stopped = false;

  const pollRuntime = async (): Promise<void> => {
    while (!stopped && isCurrentRuntimeOperation(operationToken, getState)) {
      const runtimeSnapshot = await safeGetRuntimeSnapshot();

      if (
        runtimeSnapshot &&
        !stopped &&
        isCurrentRuntimeOperation(operationToken, getState) &&
        shouldReplaceRuntimeSnapshot(getState().runtime, runtimeSnapshot)
      ) {
        setState({ runtime: runtimeSnapshot });
      }

      await delay(350);
    }
  };

  void pollRuntime();

  return () => {
    stopped = true;
  };
}

async function safeGetRuntimeSnapshot(): Promise<RuntimeSnapshot | null> {
  try {
    return await getRuntimeSnapshot();
  } catch {
    return null;
  }
}

function shouldReplaceRuntimeSnapshot(
  currentSnapshot: RuntimeSnapshot | null,
  nextSnapshot: RuntimeSnapshot,
): boolean {
  if (!currentSnapshot) {
    return true;
  }

  const currentUpdatedAt = Date.parse(currentSnapshot.updatedAt);
  const nextUpdatedAt = Date.parse(nextSnapshot.updatedAt);

  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(nextUpdatedAt)) {
    return nextUpdatedAt >= currentUpdatedAt;
  }

  return true;
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
