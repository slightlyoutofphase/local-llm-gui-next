import { describe, expect, test } from "bun:test";
import {
  getSqliteBusyRetryDelayMs,
  getSqliteBusyWorstCaseLatencyMs,
  runSqliteTransactionWithRetry,
  SQLITE_LOCK_PRESSURE_BEGIN_THRESHOLD_MS,
  SQLITE_BUSY_MAX_RETRIES,
  SQLITE_BUSY_TIMEOUT_MS,
} from "../../backend/sqliteBusyRetry";

const SQLITE_BUSY_TEST_SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function createBusyError(message = "SQLITE_BUSY: database is locked"): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };

  error.code = "SQLITE_BUSY";

  return error;
}

describe("runSqliteTransactionWithRetry", () => {
  test("retries busy begin failures with increasing backoff until the transaction starts", () => {
    const delays: number[] = [];
    const retryEvents: Array<{ attempt: number; delayMs: number; maxRetries: number }> = [];
    const calls = {
      begin: 0,
      commit: 0,
      execute: 0,
      rollback: 0,
    };

    const result = runSqliteTransactionWithRetry({
      begin: () => {
        calls.begin += 1;

        if (calls.begin < 3) {
          throw createBusyError();
        }
      },
      commit: () => {
        calls.commit += 1;
      },
      execute: () => {
        calls.execute += 1;
        return "ok";
      },
      onBusyRetry: (event) => {
        retryEvents.push(event);
      },
      rollback: () => {
        calls.rollback += 1;
      },
      sleep: (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(result).toBe("ok");
    expect(calls).toEqual({
      begin: 3,
      commit: 1,
      execute: 1,
      rollback: 0,
    });
    expect(delays).toEqual([getSqliteBusyRetryDelayMs(0), getSqliteBusyRetryDelayMs(1)]);
    expect(retryEvents).toEqual([
      {
        attempt: 1,
        delayMs: getSqliteBusyRetryDelayMs(0),
        maxRetries: SQLITE_BUSY_MAX_RETRIES,
      },
      {
        attempt: 2,
        delayMs: getSqliteBusyRetryDelayMs(1),
        maxRetries: SQLITE_BUSY_MAX_RETRIES,
      },
    ]);
  });

  test("does not retry non-busy begin failures", () => {
    const calls = {
      begin: 0,
      commit: 0,
      execute: 0,
      rollback: 0,
      sleep: 0,
    };

    expect(() =>
      runSqliteTransactionWithRetry({
        begin: () => {
          calls.begin += 1;
          throw new Error("other failure");
        },
        commit: () => {
          calls.commit += 1;
        },
        execute: () => {
          calls.execute += 1;
          return "never";
        },
        rollback: () => {
          calls.rollback += 1;
        },
        sleep: () => {
          calls.sleep += 1;
        },
      }),
    ).toThrow("other failure");

    expect(calls).toEqual({
      begin: 1,
      commit: 0,
      execute: 0,
      rollback: 0,
      sleep: 0,
    });
  });

  test("rethrows busy begin failures after the retry budget is exhausted", () => {
    let beginCalls = 0;
    const delays: number[] = [];

    expect(() =>
      runSqliteTransactionWithRetry({
        begin: () => {
          beginCalls += 1;
          throw createBusyError();
        },
        commit: () => {
          throw new Error("unexpected commit");
        },
        execute: () => {
          throw new Error("unexpected execute");
        },
        rollback: () => {
          throw new Error("unexpected rollback");
        },
        sleep: (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).toThrow("SQLITE_BUSY");

    expect(beginCalls).toBe(SQLITE_BUSY_MAX_RETRIES + 1);
    expect(delays).toEqual([
      getSqliteBusyRetryDelayMs(0),
      getSqliteBusyRetryDelayMs(1),
      getSqliteBusyRetryDelayMs(2),
      getSqliteBusyRetryDelayMs(3),
    ]);
  });

  test("reports the worst-case busy latency budget from timeout plus bounded backoff", () => {
    expect(getSqliteBusyWorstCaseLatencyMs()).toBe(
      SQLITE_BUSY_TIMEOUT_MS * (SQLITE_BUSY_MAX_RETRIES + 1) +
        getSqliteBusyRetryDelayMs(0) +
        getSqliteBusyRetryDelayMs(1) +
        getSqliteBusyRetryDelayMs(2) +
        getSqliteBusyRetryDelayMs(3),
    );
  });

  test("reports slow successful begin attempts as lock pressure even when no retry is needed", () => {
    const blockedBeginEvents: Array<{ attempt: number; elapsedMs: number; maxRetries: number }> =
      [];

    const result = runSqliteTransactionWithRetry({
      begin: () => {
        Atomics.wait(
          SQLITE_BUSY_TEST_SLEEP_SIGNAL,
          0,
          0,
          SQLITE_LOCK_PRESSURE_BEGIN_THRESHOLD_MS + 20,
        );
      },
      commit: () => {},
      execute: () => "ok",
      onBeginBlocked: (event) => {
        blockedBeginEvents.push(event);
      },
      rollback: () => {
        throw new Error("unexpected rollback");
      },
    });

    expect(result).toBe("ok");
    expect(blockedBeginEvents).toHaveLength(1);
    expect(blockedBeginEvents[0]?.attempt).toBe(1);
    expect(blockedBeginEvents[0]?.elapsedMs).toBeGreaterThanOrEqual(
      SQLITE_LOCK_PRESSURE_BEGIN_THRESHOLD_MS,
    );
  });
});
