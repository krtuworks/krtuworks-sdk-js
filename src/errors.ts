/** Refusals that lift on their own or by the player's choice: what is queued for them waits on the device. */
const WAITING_CODES: ReadonlySet<string> = new Set([
  'app_suspended',
  'account_merged',
  'account_merging',
  'sanctioned',
  'account_deletion_pending',
  'switched_off',
  'module_disabled',
]);

/** How long a queue waits after a waiting refusal that names no time, in milliseconds. */
export const WAITING_BACKOFF_MS = 15 * 60_000;

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
  /**
   * True when the error was raised while getting or refreshing the player's credentials, before the call's
   * own request was answered: it says nothing about the body of the call, so a queue never drops anything for it.
   */
  authLayer = false;

  constructor(code: string, message: string, status = 0, retryAfter: number | null = null, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'KrtuworksError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.details = details;
  }

  /** True when the server refused for a reason that can lift (a frozen app, a merge, a ban, a module or build switched off). */
  get waiting(): boolean {
    return WAITING_CODES.has(this.code) || (this.authLayer && typeof this.details.description === 'string' && this.details.description.includes('app_suspended'));
  }

  /**
   * True when a queued item must stay on the device after this error: the call can be made again, the
   * refusal can lift, or it came from the credentials and not from the item. Only a refusal of the item
   * itself, or a gone account (`account_deleted`), lets it go.
   */
  get keepsQueued(): boolean {
    if (this.code === 'account_deleted') return false;
    return this.authLayer || this.retryable || this.waiting || this.status === 401;
  }

  /** True when trying the same call again later can succeed (no answer, a busy or briefly closed server). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500 || this.code === 'account_merging';
  }
}

export function isKrtuworksError(err: unknown, code?: string): err is KrtuworksError {
  return err instanceof KrtuworksError && (code === undefined || err.code === code);
}
