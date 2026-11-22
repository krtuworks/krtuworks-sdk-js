import type { Clock } from './clock.js';
import type { ResolvedOptions } from './config.js';
import { KrtuworksError } from './errors.js';
import type { Identity } from './identity.js';
import { errorOf, send, type Answer } from './transport.js';

export interface PlayerCall {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Read the body as bytes (a file). */
  bytes?: boolean;
  keepalive?: boolean;
  /** Statuses that are answers, not failures (304, 202 …); 2xx always are. */
  accept?: number[];
  /**
   * The player the call is made for (a queue's owner, a stored save's). Default: whoever plays when the
   * call starts. The call goes only with that player's token; with any other it is not sent.
   */
  owner?: string;
}

const contextChanged = (): KrtuworksError => new KrtuworksError('context_changed', 'The player changed while the call ran; it was dropped.');

/** The player's calls to the server (`/v1`, Bearer + X-Krtu-Build). */
export class Api {
  constructor(
    private readonly opts: ResolvedOptions,
    private readonly identity: Identity,
    private readonly fetchFn: typeof fetch,
    private readonly clock: Clock,
  ) {}

  url(path: string, query?: PlayerCall['query']): string {
    const url = new URL(`${this.opts.devOrigin}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    return url.toString();
  }

  /** A call without a player (the remote config). */
  async open(path: string, call: PlayerCall = {}): Promise<Answer> {
    const answer = await send(this.fetchFn, this.clock, this.url(path, call.query), { method: call.method ?? 'GET', headers: { ...call.headers } });
    if (answer.status >= 400 && !call.accept?.includes(answer.status)) throw errorOf(answer);
    return answer;
  }

  /**
   * A player's call, for `call.owner` (or whoever plays now). Every attempt sends only with a token of that
   * player: when the token in hand is another one's (the player changed while it was fetched, or before
   * the retry after a 401), nothing is sent (`context_changed`). An expired or revoked token is refreshed
   * once and the call made again; a merged account is reported to the identity; an answer that arrives
   * after the player changed is dropped too, so it can never land in another player's state.
   */
  async player(path: string, call: PlayerCall = {}): Promise<Answer> {
    const generation = this.identity.generation;
    const owner = call.owner ?? this.identity.player?.subject ?? null;
    if (!owner) throw new KrtuworksError('signed_out', 'No player is signed in.');
    let answer = await this.attempt(path, call, false, owner);
    if (answer.status === 401) {
      const err = errorOf(answer);
      if (err.code === 'account_merged') await this.identity.markMerged(owner, typeof err.details.mergedInto === 'string' ? err.details.mergedInto : null);
      if (err.code === 'token_expired' || err.code === 'token_revoked' || err.code === 'invalid_token') answer = await this.attempt(path, call, true, owner);
    }
    if (this.identity.generation !== generation) throw contextChanged();
    if ((answer.status >= 300 || answer.status < 200) && !call.accept?.includes(answer.status)) throw errorOf(answer);
    return answer;
  }

  private async attempt(path: string, call: PlayerCall, forceRefresh: boolean, owner: string): Promise<Answer> {
    const { accessToken: token, subject } = await this.identity.credentials(forceRefresh);
    if (subject !== owner) throw contextChanged();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-krtu-build': this.opts.build, ...call.headers };
    let body: BodyInit | undefined = call.body;
    if (call.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(call.json);
    }
    return send(this.fetchFn, this.clock, this.url(path, call.query), { method: call.method ?? 'GET', headers, body, bytes: call.bytes, keepalive: call.keepalive });
  }
}
