import type { Clock } from './clock.js';
import { KrtuworksError } from './errors.js';

export interface Answer {
  status: number;
  headers: Headers;
  /** Parsed JSON, or null for an empty or non-JSON body. */
  json: Record<string, unknown> | null;
  /** The raw body, when asked for (file reads). */
  bytes: Uint8Array | null;
  /** Seconds the server asked to wait (body or `Retry-After`; a date counts from the server's clock), or null. */
  retryAfter: number | null;
}

export interface SendInit {
  method: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** Read the body as bytes instead of JSON. */
  bytes?: boolean;
  /** Let the request outlive the page (the end of a session on pagehide). */
  keepalive?: boolean;
  /** How long the whole call may take, answer body included (default `REQUEST_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/**
 * The longest a call may take, from sending to the last byte of the answer (the Unity and Unreal
 * packages use the same). A connection that stays open without finishing its answer would otherwise
 * hold every queue sent after it, and a sign-out that waits for them. Every call is safe to repeat
 * (operation, batch and upload ids), so one cut short is simply sent again later.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

function retryAfterOf(clock: Clock, headers: Headers, json: Record<string, unknown> | null): number | null {
  const fromBody = json?.retryAfter;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody)) return fromBody;
  const header = headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - clock.serverNow()) / 1000)) : null;
}

/**
 * The error an answer carries. The server and the /v1/guest calls answer `{ error: { code, message }, ...more }`;
 * the token endpoint and the device-key challenge answer OAuth's `{ error, error_description, ...more }`.
 */
export function errorOf(answer: Answer): KrtuworksError {
  const json = answer.json ?? {};
  const { error, error_description: description, ...rest } = json as Record<string, unknown>;
  let code = `http_${answer.status}`;
  let message = `The server answered ${answer.status}.`;
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string') code = e.code;
    if (typeof e.message === 'string') message = e.message;
  } else if (typeof error === 'string') {
    code = error;
    if (typeof description === 'string') message = description;
    rest.description = description;
  }
  return new KrtuworksError(code, message, answer.status, answer.retryAfter, rest);
}

/**
 * Reads `promise` unless the call's time runs out first. The abort alone does not do: a fetch given its
 * own transport (a test's, a wrapper's) may ignore the signal, and the call must end all the same.
 */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(err);
      },
    );
  });
}

export async function send(fetchFn: typeof fetch, clock: Clock, url: string, init: SendInit): Promise<Answer> {
  const host = new URL(url).host;
  const limit = init.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`no complete answer within ${Math.round(limit / 1000)} s`)), limit);
  (timer as { unref?: () => void }).unref?.();
  try {
    let res: Response;
    try {
      res = await bounded(
        fetchFn(url, { method: init.method, headers: init.headers, body: init.body ?? undefined, keepalive: init.keepalive, signal: controller.signal }),
        controller.signal,
      );
    } catch (err) {
      throw new KrtuworksError('network_error', `No answer from ${host}: ${(err as Error)?.message ?? String(err)}`);
    }
    clock.noteServerTime(res.headers.get('date'));
    let json: Record<string, unknown> | null = null;
    let bytes: Uint8Array | null = null;
    const type = res.headers.get('content-type') ?? '';
    try {
      if (init.bytes && res.ok) bytes = new Uint8Array(await bounded(res.arrayBuffer(), controller.signal));
      else if (type.includes('json')) json = (await bounded(res.json(), controller.signal)) as Record<string, unknown>;
      else await bounded(res.arrayBuffer(), controller.signal);
    } catch (err) {
      throw new KrtuworksError('network_error', `The answer from ${host} was cut: ${(err as Error)?.message ?? String(err)}`, res.status);
    }
    if (json && typeof json.serverTime === 'string') clock.noteServerTime(json.serverTime);
    return { status: res.status, headers: res.headers, json, bytes, retryAfter: retryAfterOf(clock, res.headers, json) };
  } finally {
    clearTimeout(timer);
  }
}

/** A form body: the token endpoint wants one, and a browser sends it without a preflight. */
export function form(fields: Record<string, string | undefined | null>): { body: URLSearchParams; headers: Record<string, string> } {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) body.set(k, v);
  return { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } };
}
