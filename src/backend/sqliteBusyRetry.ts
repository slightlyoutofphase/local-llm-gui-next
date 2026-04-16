const SQLITE_BUSY_SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

export const SQLITE_BUSY_TIMEOUT_MS = 250;
export const SQLITE_BUSY_MAX_RETRIES = 4;
export const SQLITE_BUSY_RETRY_BASE_DELAY_MS = 25;
export const SQLITE_LOCK_PRESSURE_BEGIN_THRESHOLD_MS = SQLITE_BUSY_RETRY_BASE_DELAY_MS;

export interface SqliteBusyRetryEvent {
  attempt: number;
  delayMs: number;
  maxRetries: number;
}

export interface SqliteBeginBlockedEvent {
  attempt: number;
  elapsedMs: number;
  maxRetries: number;
}

interface SqliteTransactionRetryOptions<T> {
  begin: () => void;
  commit: () => void;
  execute: () => T;
  onBeginBlocked?: (event: SqliteBeginBlockedEvent) => void;
  onBusyRetry?: (event: SqliteBusyRetryEvent) => void;
  rollback: () => void;
  sleep?: (delayMs: number) => void;
}

/**
 * Retries write-transaction lock acquisition when SQLite reports a busy database.
 */
export function runSqliteTransactionWithRetry<T>(options: SqliteTransactionRetryOptions<T>): T {
  let attempt = 0;

  while (true) {
    const beginStartedAt = Date.now();

    try {
      options.begin();

      const beginElapsedMs = Date.now() - beginStartedAt;

      if (beginElapsedMs >= SQLITE_LOCK_PRESSURE_BEGIN_THRESHOLD_MS) {
        options.onBeginBlocked?.({
          attempt: attempt + 1,
          elapsedMs: beginElapsedMs,
          maxRetries: SQLITE_BUSY_MAX_RETRIES,
        });
      }

      break;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= SQLITE_BUSY_MAX_RETRIES) {
        throw error;
      }

      const delayMs = getSqliteBusyRetryDelayMs(attempt);

      options.onBusyRetry?.({
        attempt: attempt + 1,
        delayMs,
        maxRetries: SQLITE_BUSY_MAX_RETRIES,
      });
      (options.sleep ?? sleepSqliteBusyRetryDelay)(delayMs);
      attempt += 1;
    }
  }

  try {
    const result = options.execute();

    options.commit();

    return result;
  } catch (error) {
    options.rollback();
    throw error;
  }
}

export function getSqliteBusyRetryDelayMs(attempt: number): number {
  return SQLITE_BUSY_RETRY_BASE_DELAY_MS * 2 ** attempt;
}

export function getSqliteBusyWorstCaseLatencyMs(busyTimeoutMs = SQLITE_BUSY_TIMEOUT_MS): number {
  let totalLatencyMs = busyTimeoutMs * (SQLITE_BUSY_MAX_RETRIES + 1);

  for (let attempt = 0; attempt < SQLITE_BUSY_MAX_RETRIES; attempt += 1) {
    totalLatencyMs += getSqliteBusyRetryDelayMs(attempt);
  }

  return totalLatencyMs;
}

export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;

  return (
    code === "SQLITE_BUSY" ||
    error.message.includes("SQLITE_BUSY") ||
    error.message.includes("database is locked")
  );
}

function sleepSqliteBusyRetryDelay(delayMs: number): void {
  if (delayMs <= 0) {
    return;
  }

  Atomics.wait(SQLITE_BUSY_SLEEP_SIGNAL, 0, 0, delayMs);
}
