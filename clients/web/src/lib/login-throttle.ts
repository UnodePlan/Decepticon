/**
 * In-process login throttle.
 *
 * Self-hosted deployments run a single web container, so an in-memory
 * counter is enough to stop online password guessing; a restart clears it
 * (acceptable — the attacker still needs the credentials).
 */

export interface ThrottleOptions {
  /** Failures allowed inside the window before requests are rejected. */
  maxFailures: number;
  /** Sliding window length in milliseconds. */
  windowMs: number;
}

export interface ThrottleState {
  failures: number;
  /** Epoch ms of the first failure in the current window. */
  firstFailureAt: number;
}

const DEFAULTS: ThrottleOptions = { maxFailures: 10, windowMs: 5 * 60_000 };

/**
 * Retry-after in seconds when `key` is currently locked out, otherwise 0.
 * Pure — callers own the store and the clock.
 */
export function retryAfterSeconds(
  state: ThrottleState | undefined,
  now: number,
  options: ThrottleOptions = DEFAULTS,
): number {
  if (!state) return 0;
  if (now - state.firstFailureAt >= options.windowMs) return 0;
  if (state.failures < options.maxFailures) return 0;
  return Math.max(1, Math.ceil((state.firstFailureAt + options.windowMs - now) / 1000));
}

/** Fold a failed attempt into the store, resetting after the window elapses. */
export function recordFailure(
  store: Map<string, ThrottleState>,
  key: string,
  now: number,
  options: ThrottleOptions = DEFAULTS,
): void {
  const existing = store.get(key);
  if (!existing || now - existing.firstFailureAt >= options.windowMs) {
    store.set(key, { failures: 1, firstFailureAt: now });
    return;
  }
  store.set(key, { failures: existing.failures + 1, firstFailureAt: existing.firstFailureAt });
}

/** Called after a successful sign-in so a legit user is never held out. */
export function clearFailures(store: Map<string, ThrottleState>, key: string): void {
  store.delete(key);
}
