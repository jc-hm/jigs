// Automatic retry policy for transient fill failures (AI capacity blips).
// The server already retries Bedrock internally before surfacing a 503, so
// these waits are deliberately modest: a few more chances, then hand control
// back to the user with a manual Retry rather than spinning for minutes.

export const AUTO_RETRY_BASE_MS = [5_000, 15_000, 30_000];

/** Backoff for the Nth auto-retry (0-based), ±20% jitter, never shorter than a server Retry-After. */
export function autoRetryDelayMs(attempt: number, retryAfterMs = 0): number {
  const jittered = (AUTO_RETRY_BASE_MS[attempt] ?? 0) * (0.8 + Math.random() * 0.4);
  return Math.round(Math.max(jittered, retryAfterMs));
}

/** setTimeout that rejects with an AbortError when the signal fires. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
