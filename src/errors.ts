/**
 * Every failure the SDK reports. `code` is the server's code (the server `{ error: { code } }`, Krtuworks ID's
 * OAuth `error`), or one of the SDK's own:
 *   - network_error: no answer (offline, DNS, a dropped connection); the call may or may not have arrived
 *   - context_changed: the account or environment changed while the call ran; its answer was dropped
 *   - signed_out: the call needs a player and none is signed in
 *   - switched_off: the owner switched this build off (`message` says why)
 */
export class KrtuworksError extends Error {
  /** HTTP status; 0 when nothing came back. */
  readonly status: number;
  readonly code: string;
  /** Seconds to wait before trying again, when the server said so. */
  readonly retryAfter: number | null;
  /** The rest of the server's answer (`mergedInto`, `current`, `endsAt`, `terms` …). */
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status = 0, retryAfter: number | null = null, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'KrtuworksError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.details = details;
  }

  /** True when trying the same call again later can succeed (no answer, a busy or briefly closed server). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500 || this.code === 'account_merging';
  }
}

export function isKrtuworksError(err: unknown, code?: string): err is KrtuworksError {
  return err instanceof KrtuworksError && (code === undefined || err.code === code);
}
