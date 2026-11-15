import { createVerify } from 'node:crypto';
import { memoryStore } from '../src/store.js';
import type { KrtuworksOptions } from '../src/config.js';

export interface Reply {
  status?: number;
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  form: URLSearchParams | null;
  json: any;
  raw: Uint8Array;
}

type Handler = (call: Call) => Reply | Promise<Reply>;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** An unsigned JWT the SDK reads (it never checks signatures: the servers do). */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64({ alg: 'ES256', typ: 'at+jwt' })}.${b64(claims)}.sig`;
}

/** A stand-in for id. and dev.: routes by method and path, records every call. */
export class FakeServer {
  readonly calls: Call[] = [];
  private readonly routes = new Map<string, Handler>();
  /** Calls to these paths fail with no answer (a dropped connection). */
  readonly offline = new Set<string>();

  on(method: string, path: string, handler: Handler): this {
    this.routes.set(`${method} ${path}`, handler);
    return this;
  }

  count(method: string, path: string): number {
    return this.calls.filter((c) => c.method === method && c.path === path).length;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit);
    let raw = new Uint8Array();
    if (init?.body instanceof URLSearchParams) raw = new TextEncoder().encode(init.body.toString());
    else if (typeof init?.body === 'string') raw = new TextEncoder().encode(init.body);
    else if (init?.body instanceof Uint8Array) raw = init.body;
    if (headers.get('content-encoding') === 'gzip') {
      raw = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    const text = new TextDecoder().decode(raw);
    const type = headers.get('content-type') ?? '';
    const call: Call = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      raw,
      form: type.includes('x-www-form-urlencoded') ? new URLSearchParams(text) : null,
      json: type.includes('json') && text ? JSON.parse(text) : null,
    };
    this.calls.push(call);
    if (this.offline.has(url.pathname)) throw new TypeError('fetch failed');
    const handler = this.routes.get(`${method} ${url.pathname}`);
    const reply = handler ? await handler(call) : { status: 404, json: { error: { code: 'not_found', message: url.pathname } } };
    const h = new Headers({ date: new Date().toUTCString(), ...reply.headers });
    if (reply.json !== undefined) {
      h.set('content-type', 'application/json');
      return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: h });
    }
    return new Response(reply.status === 304 || reply.status === 204 ? null : ((reply.body ?? new Uint8Array()) as BodyInit), { status: reply.status ?? 200, headers: h });
  };
}

/** Checks a device-key proof the way Krtuworks ID does (header, signature, claims). */
export function verifyProof(assertion: string): { header: any; payload: any; ok: boolean } {
  const [h, p, s] = assertion.split('.');
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
  const raw = Buffer.from(s!, 'base64url');
  // JWS ES256 is raw r||s; node's verifier takes it with dsaEncoding ieee-p1363.
  const ok = createVerify('SHA256').update(`${h}.${p}`).verify({ key: { kty: 'EC', crv: 'P-256', x: header.jwk.x, y: header.jwk.y }, format: 'jwk', dsaEncoding: 'ieee-p1363' }, raw);
  return { header, payload, ok };
}

export const APP = { appId: 'app_aaaaaaaaaaaaaaaaaaaa', slug: 'buried', environments: { TEST: { clientId: 'buried.test.native', webClientId: 'buried.test.web' } } };

export function options(server: FakeServer, extra: Partial<KrtuworksOptions> = {}): KrtuworksOptions {
  return {
    config: APP,
    environment: 'TEST',
    platform: 'WEB',
    build: '1.0.0',
    clientKind: 'web',
    fetch: server.fetch,
    store: memoryStore(),
    sessions: false,
    redirectUri: 'https://play.example/callback',
    ...extra,
  };
}

let tokenSeq = 0;
/** A token answer for `sub`, with a fresh refresh token unless one is given. */
export function tokenAnswer(sub: string, extra: Record<string, unknown> = {}, ttlSeconds = 600): Record<string, unknown> {
  tokenSeq += 1;
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: fakeJwt({ sub, aud: 'devapi', exp: now + ttlSeconds, scope: 'app:player', n: tokenSeq }),
    refresh_token: `rt-${tokenSeq}`,
    id_token: fakeJwt({ iss: 'https://id.krtuworks.com/oidc', sub, aud: 'buried.test.web', exp: now + 600, ...extra }),
    token_type: 'Bearer',
    expires_in: ttlSeconds,
  };
}

/** Routes a device-key guest through: challenge and grant (one guest per key). */
export function guestRoutes(server: FakeServer, sub = 'pw_guest_aaaaaaaaaaaa'): void {
  let nonce = 0;
  const known = new Set<string>();
  server.on('POST', '/oidc/device-key/challenge', () => ({ json: { nonce: `n${(nonce += 1)}`.padEnd(43, 'x'), expires_in: 60 } }));
  server.on('POST', '/oidc/token', (call) => {
    const grant = call.form!.get('grant_type');
    if (grant === 'urn:krtuworks:params:oauth:grant-type:device-key') {
      const { payload, ok } = verifyProof(call.form!.get('assertion')!);
      if (!ok) return { status: 400, json: { error: 'invalid_grant', error_description: 'The device key proof was refused: signature.' } };
      if (!known.has(payload.key_thumbprint)) {
        if (!call.form!.get('birth_date')) return { status: 400, json: { error: 'invalid_birth_date', error_description: 'Enter a valid date of birth.' } };
        if (call.form!.get('accepted_terms') !== 'TERMS:v1 PRIVACY:v1') return { status: 400, json: { error: 'terms_required', error_description: 'Accept the current terms: TERMS:v2 PRIVACY:v1.' } };
        known.add(payload.key_thumbprint);
      }
      return { json: tokenAnswer(sub) };
    }
    if (grant === 'refresh_token') return { json: tokenAnswer(sub) };
    return { status: 400, json: { error: 'unsupported_grant_type' } };
  });
}

export interface PresenceFake {
  states: Array<{ key: string; token: string; params: string[] }>;
  visible: boolean;
  /** Answers module_disabled while false. */
  on: boolean;
}

/** The three rich presence routes: states with an ETag (304 on a match), the choice read and written. */
export function presenceRoutes(server: FakeServer, fake: PresenceFake): void {
  const off = { status: 403, json: { error: { code: 'module_disabled', message: 'presence is off' } } };
  server.on('GET', '/v1/me/presence-states', (call) => {
    if (!fake.on) return off;
    const etag = `"p${fake.states.length}"`;
    if (call.headers.get('if-none-match') === etag) return { status: 304 };
    return { json: { states: fake.states, visible: fake.visible, serverTime: new Date().toISOString() }, headers: { etag } };
  });
  server.on('GET', '/v1/me/presence-visibility', () => (fake.on ? { json: { visible: fake.visible, updatedAt: null } } : off));
  server.on('PUT', '/v1/me/presence-visibility', (call) => {
    if (!fake.on) return off;
    fake.visible = call.json.visible === true;
    return { json: { visible: fake.visible, updatedAt: new Date().toISOString() } };
  });
}
