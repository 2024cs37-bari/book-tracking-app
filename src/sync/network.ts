/** Shared HTTP policy. Retry-After accepts either delta seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return seconds >= 0 ? Math.min(seconds * 1000, Number.MAX_SAFE_INTEGER - now) : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export interface NetworkFailure {
  retryable: boolean;
  authExpired?: boolean;
  retryAfterMs?: number;
}

export function failurePolicy(error: unknown): NetworkFailure {
  if (error !== null && typeof error === 'object' && 'options' in error) {
    const options = error.options;
    if (options !== null && typeof options === 'object' && 'retryable' in options) {
      return options as NetworkFailure;
    }
  }
  // Fetch network and timeout errors are transient. Unexpected application
  // errors pause rather than spinning forever against corrupt local state.
  return {
    retryable:
      error instanceof TypeError ||
      (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)),
  };
}

export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return Math.round(Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 9)) * (0.75 + random() * 0.5));
}

export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}
