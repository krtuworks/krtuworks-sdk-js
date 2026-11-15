import type { Clock } from './clock.js';
import { KrtuworksError } from './errors.js';

export interface Answer {
  status: number;
  headers: Headers;
  /** Parsed JSON, or null for an empty or non-JSON body. */
  json: Record<string, unknown> | null;
  /** The raw body, when asked for (file reads). */
  bytes: Uint8Array | null;
}

export interface SendInit {
  method: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** Read the body as bytes instead of JSON. */
  bytes?: boolean;
  /** Let the request outlive the page (the end of a session on pagehide). */
  keepalive?: boolean;
}

function retryAfterOf(headers: Headers, json: Record<string, unknown> | null): number | null {
  const fromBody = json?.retryAfter;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody)) return fromBody;
  const header = headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
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
  return new KrtuworksError(code, message, answer.status, retryAfterOf(answer.headers, answer.json), rest);
}

export async function send(fetchFn: typeof fetch, clock: Clock, url: string, init: SendInit): Promise<Answer> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: init.method, headers: init.headers, body: init.body ?? undefined, keepalive: init.keepalive });
  } catch (err) {
    throw new KrtuworksError('network_error', `No answer from ${new URL(url).host}: ${(err as Error)?.message ?? String(err)}`);
  }
  clock.noteServerTime(res.headers.get('date'));
  let json: Record<string, unknown> | null = null;
  let bytes: Uint8Array | null = null;
  const type = res.headers.get('content-type') ?? '';
  try {
    if (init.bytes && res.ok) bytes = new Uint8Array(await res.arrayBuffer());
    else if (type.includes('json')) json = (await res.json()) as Record<string, unknown>;
    else await res.arrayBuffer();
  } catch (err) {
    throw new KrtuworksError('network_error', `The answer from ${new URL(url).host} was cut: ${(err as Error)?.message ?? String(err)}`, res.status);
  }
  if (json && typeof json.serverTime === 'string') clock.noteServerTime(json.serverTime);
  return { status: res.status, headers: res.headers, json, bytes };
}

/** A form body: the token endpoint wants one, and a browser sends it without a preflight. */
export function form(fields: Record<string, string | undefined | null>): { body: URLSearchParams; headers: Record<string, string> } {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) body.set(k, v);
  return { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } };
}
