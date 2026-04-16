export function canStartGeneration(options: {
  activeAbortController: AbortController | null;
  sending: boolean;
}): boolean {
  return !options.sending && !options.activeAbortController;
}

export function clearAbortControllerIfCurrent(
  activeAbortController: AbortController | null,
  completedAbortController: AbortController,
): AbortController | null {
  return activeAbortController === completedAbortController ? null : activeAbortController;
}

export async function stopGenerationSafely(options: {
  abortController: AbortController | null;
  stopRemoteGeneration: () => Promise<boolean>;
}): Promise<void> {
  const { abortController, stopRemoteGeneration } = options;

  if (!abortController) {
    return;
  }

  abortController.abort();

  try {
    await stopRemoteGeneration();
  } catch {
    // The local abort is authoritative; the backend stop request is best-effort cleanup.
  }
}
