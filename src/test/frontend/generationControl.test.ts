import { describe, expect, test } from "bun:test";
import {
  canStartGeneration,
  clearAbortControllerIfCurrent,
  stopGenerationSafely,
} from "../../lib/generationControl";

describe("stopGenerationSafely", () => {
  test("aborts locally before waiting for the remote stop request", async () => {
    const abortController = new AbortController();
    const callOrder: string[] = [];
    let resolveRemoteStop: ((value: boolean) => void) | null = null;

    const stopPromise = stopGenerationSafely({
      abortController,
      stopRemoteGeneration: async () => {
        callOrder.push("remote-stop");

        return await new Promise<boolean>((resolve) => {
          resolveRemoteStop = resolve;
        });
      },
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(callOrder).toEqual(["remote-stop"]);

    resolveRemoteStop?.(true);
    await stopPromise;
  });

  test("swallows remote stop failures after the local abort path runs", async () => {
    const abortController = new AbortController();

    await expect(
      stopGenerationSafely({
        abortController,
        stopRemoteGeneration: async () => {
          throw new Error("backend stop failed");
        },
      }),
    ).resolves.toBeUndefined();

    expect(abortController.signal.aborted).toBe(true);
  });

  test("no-ops when there is no active abort controller", async () => {
    let remoteStopCalled = false;

    await stopGenerationSafely({
      abortController: null,
      stopRemoteGeneration: async () => {
        remoteStopCalled = true;
        return true;
      },
    });

    expect(remoteStopCalled).toBe(false);
  });
});

describe("generation control helpers", () => {
  test("prevents new generation while a stream is still active or unwinding", () => {
    expect(canStartGeneration({ activeAbortController: null, sending: false })).toBe(true);
    expect(
      canStartGeneration({ activeAbortController: new AbortController(), sending: false }),
    ).toBe(false);
    expect(canStartGeneration({ activeAbortController: null, sending: true })).toBe(false);
  });

  test("only clears the abort controller for the stream that actually finished", () => {
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();

    expect(clearAbortControllerIfCurrent(firstAbortController, firstAbortController)).toBeNull();
    expect(clearAbortControllerIfCurrent(secondAbortController, firstAbortController)).toBe(
      secondAbortController,
    );
  });
});
