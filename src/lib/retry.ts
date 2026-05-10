/**
 * Backoff exponencial compartido para llamadas a APIs externas (HubSpot + Meta).
 *
 * Defaults alineados con CLAUDE.md: 3 intentos, base 1s. Solo reintenta sobre 429 y 5xx.
 */

export type RetryableError = Error & {
  code?: number;
  status?: number;
  response?: { status?: number };
};

function isRetryable(err: unknown): boolean {
  const e = err as RetryableError;
  const status = e?.code ?? e?.status ?? e?.response?.status;
  if (typeof status !== 'number') return false;
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Ejecuta `fn` con backoff exponencial. Backoffs por default: 1s, 2s (entre intento 1→2 y 2→3).
 * Re-lanza el error original si no es retryable o se agotan los reintentos.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
