"use client";

import { useEffect, useEffectEvent } from "react";
import type { ReactElement, ReactNode } from "react";
import { readUiCacheBestEffort } from "@/lib/ui-cache";
import { subscribeToUiCacheSync, subscribeToWindowActivation } from "@/lib/uiCacheSync";
import { useChatStore } from "@/store/chatStore";
import { buildChatStoreModelContext } from "@/store/chatModelBridge";
import { useModelStore } from "@/store/modelStore";
import { setChatStoreModelSelectionHandler } from "@/store/chatStore";

export interface ProvidersProps {
  children: ReactNode;
}

interface ClientStoreBootstrapDependencies {
  connectDebugStream(): void;
  connectRuntimeStream(): void;
  hydrateChats(): Promise<void>;
  hydrateModels(): Promise<void>;
}

/** Hydrates the client stores in a deterministic order before opening SSE streams. */
export async function initializeClientStores(
  dependencies: ClientStoreBootstrapDependencies,
): Promise<void> {
  await dependencies.hydrateModels();
  await dependencies.hydrateChats();
  dependencies.connectRuntimeStream();
  dependencies.connectDebugStream();
}

/**
 * Provides the client-side boundary for frontend state, hydration, and browser-only effects.
 *
 * @param props Provider props.
 * @param props.children Descendant UI content.
 * @returns The wrapped application subtree.
 */
export function Providers({ children }: ProvidersProps): ReactElement {
  const theme = useModelStore((state) => state.config?.theme ?? "system");

  const initializeStores = useEffectEvent(async () => {
    await initializeClientStores({
      connectDebugStream: () => {
        useChatStore.getState().connectDebugStream();
      },
      connectRuntimeStream: () => {
        useModelStore.getState().connectRuntimeStream();
      },
      hydrateChats: async () => {
        await useChatStore.getState().hydrate();
      },
      hydrateModels: async () => {
        await useModelStore.getState().hydrate();
      },
    });
  });

  const applyTheme = useEffectEvent(() => {
    const rootElement = document.documentElement;
    const prefersDarkMode = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const shouldUseDarkTheme = theme === "dark" || (theme === "system" && prefersDarkMode);

    rootElement.classList.toggle("dark", shouldUseDarkTheme);
  });

  const synchronizeExternalClientState = useEffectEvent(async () => {
    const uiCache = await readUiCacheBestEffort();

    await useModelStore.getState().synchronizeFromUiCache(uiCache);
    await useChatStore.getState().synchronizeFromUiCache(uiCache);
  });

  useEffect(() => {
    let disposed = false;
    let stopUiCacheSync = (): void => {};
    let stopWindowActivation = (): void => {};
    let unsubscribeModelStore = (): void => {};

    const startClientCoordination = (): void => {
      const syncModelContext = (state = useModelStore.getState()): void => {
        useChatStore.getState().syncModelContext(
          buildChatStoreModelContext({
            config: state.config,
            loadInferencePresetsByModelId: state.loadInferencePresetsByModelId,
            models: state.models,
            runtime: state.runtime,
            selectedLoadPresetIds: state.selectedLoadPresetIds,
            selectedModelId: state.selectedModelId,
          }),
        );
      };

      syncModelContext();
      setChatStoreModelSelectionHandler((modelId) => {
        void useModelStore.getState().selectModel(modelId);
      });
      unsubscribeModelStore = useModelStore.subscribe((state) => {
        syncModelContext(state);
      });
      stopUiCacheSync = subscribeToUiCacheSync(() => {
        void synchronizeExternalClientState();
      });
      stopWindowActivation = subscribeToWindowActivation(() => {
        void synchronizeExternalClientState();
      });
    };

    void initializeStores().then(() => {
      if (disposed) {
        return;
      }

      startClientCoordination();
    });

    return () => {
      disposed = true;
      stopUiCacheSync();
      stopWindowActivation();
      unsubscribeModelStore();
      setChatStoreModelSelectionHandler(null);
      useModelStore.getState().disconnectRuntimeStream();
      useChatStore.getState().disconnectDebugStream();
    };
  }, []);

  useEffect(() => {
    applyTheme();
    const mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (): void => {
      applyTheme();
    };

    mediaQueryList.addEventListener("change", handleChange);

    return () => {
      mediaQueryList.removeEventListener("change", handleChange);
    };
  }, [theme]);

  return <>{children}</>;
}
