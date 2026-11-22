import type { Clock } from './clock.js';
import { CURRENT_TERMS, DEV_RESOURCE, GUEST_SCOPE, PLAYER_SCOPE, type ResolvedOptions } from './config.js';
import { createDeviceKey, signProof, type DeviceKey, type ProofPurpose } from './deviceKey.js';
import { KrtuworksError } from './errors.js';
import { base64Url, randomToken, sha256 } from './ids.js';
import { jwtClaims } from './jwt.js';
import { withLock } from './locks.js';
import type { KrtuStore } from './store.js';
import { errorOf, form, send, type Answer } from './transport.js';

export type PlayerKind = 'guest' | 'account';

export interface Player {
  kind: PlayerKind;
  /** The id this app knows the player by: the same on every device, never the Krtuworks ID itself. */
  subject: string;
  username: string | null;
  picture: string | null;
}

interface StoredTokens extends Player {
  accessToken: string;
  /** Milliseconds on the server's clock. */
  accessExpiresAt: number;
  refreshToken: string | null;
}

/** The device key as stored: `known` once the server has taken it (a lost answer leaves it unknown), with its guest. */
interface StoredKey extends DeviceKey {
  known: boolean;
  subject: string | null;
}

interface IdentityMeta {
  /** Bumped by every sign-in the player starts and every sign-out. */
  epoch: number;
  /** Players whose waiting queues move to the signed-in one once the server confirms a merge. */
  waitingOwners: string[];
  /** The age screen's answers for a guest not made yet: tried again on every launch. */
  guestRequest: { birthDate: string; acceptedTerms: string } | null;
}

interface PendingSignIn {
  verifier: string;
  nonce: string;
  redirectUri: string;
  epoch: number;
  startedAt: number;
}

export type IdentityChange =
  | { type: 'signed_in'; player: Player; promoted: boolean }
  | { type: 'guest'; player: Player; created: boolean }
  | { type: 'signed_out'; reason: string }
  | { type: 'merged'; previousSubject: string; mergedInto: string | null }
  | { type: 'deletion_pending' }
  | { type: 'sanctioned'; reason: string | null };

export interface IdentityContext {
  opts: ResolvedOptions;
  store: KrtuStore;
  fetch: typeof fetch;
  clock: Clock;
}

export const DEVICE_KEY_GRANT = 'urn:krtuworks:params:oauth:grant-type:device-key';
const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_EARLY_MS = 60_000;

function signedOut(): KrtuworksError {
  return new KrtuworksError('signed_out', 'No player is signed in.');
}

/** `terms_required` names the documents in its text: `Accept the current terms: TERMS:v2 PRIVACY:v1.` */
export function termsIn(text: string): string | null {
  const named = text.match(/\b[A-Z][A-Z_]*:v\d+\b/g);
  return named ? [...new Set(named)].join(' ') : null;
}

/**
 * Who plays: the tokens, the device's guest key, and every way a player arrives or leaves. One token
 * chain per sign-in client; every write of it happens under one lock (Web Locks across tabs), and a
 * refresh writes its answer only over the refresh token it spent.
 */
export class Identity {
  private tokens: StoredTokens | null = null;
  private refreshing: Promise<StoredTokens> | null = null;
  private readonly listeners = new Set<(change: IdentityChange) => void>();
  /** Bumped whenever the signed-in player changes; an answer made for another one is dropped. */
  generation = 0;

  constructor(private readonly ctx: IdentityContext) {}

  private key(name: string): string {
    return `krtu:${this.ctx.opts.clientId}:${name}`;
  }

  private get lockName(): string {
    return `krtu:${this.ctx.opts.clientId}:identity`;
  }

  private get issuer(): string {
    return `${this.ctx.opts.idOrigin}/oidc`;
  }

  async load(): Promise<Player | null> {
    this.tokens = (await this.ctx.store.get<StoredTokens>(this.key('tokens'))) ?? null;
    return this.player;
  }

  get player(): Player | null {
    const t = this.tokens;
    return t ? { kind: t.kind, subject: t.subject, username: t.username, picture: t.picture } : null;
  }

  onChange(listener: (change: IdentityChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: IdentityChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // a listener's failure is the app's; the SDK goes on
      }
    }
  }

  async meta(): Promise<IdentityMeta> {
    const meta = await this.ctx.store.get<IdentityMeta>(this.key('meta'));
    return { epoch: meta?.epoch ?? 0, waitingOwners: meta?.waitingOwners ?? [], guestRequest: meta?.guestRequest ?? null };
  }

  private async saveMeta(meta: IdentityMeta): Promise<void> {
    await this.ctx.store.set(this.key('meta'), meta);
  }

  /** The owners whose queues wait for a merge check, with the one to drop once it is answered. */
  async waitingOwners(): Promise<string[]> {
    return (await this.meta()).waitingOwners;
  }

  /** The merge of `subject` is settled: it no longer waits, and its guest key (retired by the server) goes. */
  async forgetWaitingOwner(subject: string): Promise<void> {
    await withLock(this.lockName, async () => {
      const meta = await this.meta();
      meta.waitingOwners = meta.waitingOwners.filter((s) => s !== subject);
      await this.saveMeta(meta);
      const key = await this.ctx.store.get<StoredKey>(this.key('deviceKey'));
      if (key?.subject === subject) await this.ctx.store.delete(this.key('deviceKey'));
    });
  }

  /** Writes who is signed in (or nobody); a different player bumps the generation. */
  private async adopt(next: StoredTokens | null): Promise<void> {
    if (next) await this.ctx.store.set(this.key('tokens'), next);
    else await this.ctx.store.delete(this.key('tokens'));
    if ((this.tokens?.subject ?? null) !== (next?.subject ?? null)) this.generation += 1;
    this.tokens = next;
  }

  // ── Tokens ──────────────────────────────────────────────────────────────

  /**
   * A valid access token, refreshed first when it is about to expire (or `force`: the server said it was).
   * One refresh at a time in this tab (single flight) and across tabs (the lock).
   */
  async accessToken(force = false): Promise<string> {
    return (await this.credentials(force)).accessToken;
  }

  /**
   * The access token together with the player it belongs to, read from the same stored tokens: a refresh
   * may hand back another player's tokens (another tab signed in meanwhile), and only the pair says whose.
   */
  async credentials(force = false): Promise<{ accessToken: string; subject: string }> {
    const t = this.tokens;
    if (!t) throw signedOut();
    if (!force && t.accessExpiresAt - REFRESH_EARLY_MS > this.ctx.clock.serverNow()) return { accessToken: t.accessToken, subject: t.subject };
    this.refreshing ??= this.refresh(t.accessToken).finally(() => {
      this.refreshing = null;
    });
    const next = await this.refreshing;
    return { accessToken: next.accessToken, subject: next.subject };
  }

  private async token(fields: Record<string, string | undefined>): Promise<Answer> {
    const { body, headers } = form({ client_id: this.ctx.opts.clientId, ...fields });
    return send(this.ctx.fetch, this.ctx.clock, `${this.ctx.opts.idOrigin}/oidc/token`, { method: 'POST', headers, body });
  }

  private tokensFrom(json: Record<string, unknown> | null, kind: PlayerKind, previous: StoredTokens | null): StoredTokens {
    const access = json?.access_token;
    if (typeof access !== 'string') throw new KrtuworksError('invalid_response', 'The token answer carries no access token.');
    const claims = jwtClaims(access);
    const id = typeof json?.id_token === 'string' ? jwtClaims(json.id_token) : null;
    const subject = String(claims.sub ?? id?.sub ?? '');
    if (!subject) throw new KrtuworksError('invalid_response', 'The access token names no player.');
    const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : this.ctx.clock.serverNow() + 600_000;
    const sameSubject = previous?.subject === subject;
    return {
      kind,
      subject,
      username: typeof id?.preferred_username === 'string' ? id.preferred_username : sameSubject ? previous!.username : null,
      picture: typeof id?.picture === 'string' ? id.picture : sameSubject ? previous!.picture : null,
      accessToken: access,
      accessExpiresAt: exp,
      refreshToken: typeof json?.refresh_token === 'string' ? json.refresh_token : sameSubject ? previous!.refreshToken : null,
    };
  }

  private async refresh(usedAccess: string): Promise<StoredTokens> {
    return withLock(this.lockName, async () => {
      const stored = (await this.ctx.store.get<StoredTokens>(this.key('tokens'))) ?? null;
      if (!stored) {
        await this.adopt(null);
        throw signedOut();
      }
      if (stored.accessToken !== usedAccess && stored.accessExpiresAt - REFRESH_EARLY_MS > this.ctx.clock.serverNow()) {
        await this.adopt(stored);
        return stored;
      }
      if (!stored.refreshToken) {
        if (stored.kind === 'guest') return this.guestAgain(stored);
        await this.adopt(null);
        this.emit({ type: 'signed_out', reason: 'expired' });
        throw signedOut();
      }
      const answer = await this.token({ grant_type: 'refresh_token', refresh_token: stored.refreshToken, resource: DEV_RESOURCE });
      if (answer.status === 200) {
        const next = this.tokensFrom(answer.json, stored.kind, stored);
        await this.adopt(next);
        return next;
      }
      return this.refused(stored, errorOf(answer));
    });
  }

  /** A refresh the server refused, read by what it says; under the identity lock. */
  private async refused(stored: StoredTokens, err: KrtuworksError): Promise<StoredTokens> {
    if (err.code !== 'invalid_grant') throw err;
    const why = String(err.details.description ?? err.message);
    if (why.includes('account_merged')) return this.markMergedLocked(stored.subject, null);
    // A frozen app keeps its grants: the same refresh token works again once it is resumed.
    if (why.includes('app_suspended')) throw err;
    await this.adopt(null);
    if (why.includes('sanctioned')) {
      this.emit({ type: 'sanctioned', reason: null });
      throw new KrtuworksError('sanctioned', 'The player is banned from this app.', 403);
    }
    if (why.includes('account_deletion_pending')) {
      this.emit({ type: 'deletion_pending' });
      throw new KrtuworksError('account_deletion_pending', 'This account is waiting to be deleted.', 403);
    }
    // Revoked or expired: a guest signs in again with its key, anyone else needs the player.
    if (stored.kind === 'guest') return this.guestAgain(stored);
    this.emit({ type: 'signed_out', reason: why });
    throw signedOut();
  }

  /**
   * The merged player's queues wait for the merge check. Only when that player is still the signed-in one
   * are its tokens dropped and the app told: a late answer for a player who already left must not sign
   * out the one who plays now.
   */
  private async markMergedLocked(previousSubject: string, mergedInto: string | null): Promise<never> {
    const meta = await this.meta();
    if (!meta.waitingOwners.includes(previousSubject)) meta.waitingOwners.push(previousSubject);
    await this.saveMeta(meta);
    const stored = (await this.ctx.store.get<StoredTokens>(this.key('tokens'))) ?? null;
    if (stored?.subject === previousSubject) {
      await this.adopt(null);
      this.emit({ type: 'merged', previousSubject, mergedInto });
    }
    throw new KrtuworksError('account_merged', 'This account was merged into another one; sign in with it.', 401, null, { mergedInto });
  }

  /** The server said a player's account went into another one (401 account_merged on that player's call). */
  async markMerged(previousSubject: string, mergedInto: string | null): Promise<never> {
    return withLock(this.lockName, () => this.markMergedLocked(previousSubject, mergedInto));
  }

  // ── Guests (device key) ──────────────────────────────────────────────────

  private async challenge(purpose: ProofPurpose): Promise<string> {
    const { body, headers } = form({ client_id: this.ctx.opts.clientId, purpose });
    const answer = await send(this.ctx.fetch, this.ctx.clock, `${this.ctx.opts.idOrigin}/oidc/device-key/challenge`, { method: 'POST', headers, body });
    if (answer.status !== 200 || typeof answer.json?.nonce !== 'string') throw errorOf(answer);
    return answer.json.nonce;
  }

  private async proofWith(key: DeviceKey, purpose: ProofPurpose): Promise<string> {
    const nonce = await this.challenge(purpose);
    return signProof(key, { nonce, clientId: this.ctx.opts.clientId, purpose, iat: Math.floor(this.ctx.clock.serverNow() / 1000) });
  }

  /** A proof by this device's guest key for one of the guest's own calls (deletion, data copy). */
  async guestProof(purpose: ProofPurpose): Promise<string> {
    const key = await this.ctx.store.get<StoredKey>(this.key('deviceKey'));
    if (!key?.known) throw new KrtuworksError('no_guest_key', 'This device holds no guest key.');
    return this.proofWith(key, purpose);
  }

  /** The device-key grant; the caller holds the identity lock. */
  private async deviceKeyGrant(request: IdentityMeta['guestRequest']): Promise<{ tokens: StoredTokens; created: boolean }> {
    let key = await this.ctx.store.get<StoredKey>(this.key('deviceKey'));
    if (!key) {
      // Stored before the server hears of it: a lost answer must not leave a guest no key can reach.
      key = { ...(await createDeviceKey()), known: false, subject: null };
      await this.ctx.store.set(this.key('deviceKey'), key);
    }
    if (!key.known && !request) throw new KrtuworksError('birth_date_required', 'A new guest needs the age screen: pass birthDate and acceptedTerms.', 400);
    const assertion = await this.proofWith(key, 'login');
    const answer = await this.token({
      grant_type: DEVICE_KEY_GRANT,
      assertion,
      scope: GUEST_SCOPE,
      resource: DEV_RESOURCE,
      birth_date: key.known ? undefined : request!.birthDate,
      accepted_terms: key.known ? undefined : request!.acceptedTerms,
    });
    if (answer.status !== 200) {
      const err = errorOf(answer);
      if (err.code === 'terms_required') err.details.terms = termsIn(err.message);
      throw err;
    }
    const created = !key.known;
    const tokens = this.tokensFrom(answer.json, 'guest', null);
    if (created || key.subject !== tokens.subject) await this.ctx.store.set(this.key('deviceKey'), { ...key, known: true, subject: tokens.subject });
    return { tokens, created };
  }

  /** A guest whose refresh token is gone signs in again with its key; under the identity lock. */
  private async guestAgain(stored: StoredTokens): Promise<StoredTokens> {
    try {
      const { tokens } = await this.deviceKeyGrant(null);
      await this.adopt(tokens);
      return tokens;
    } catch (err) {
      const e = err as KrtuworksError;
      if (e.code !== 'invalid_grant' && e.code !== 'birth_date_required') throw err;
      const why = String(e.details?.description ?? e.message);
      if (why.includes('account_merged')) return this.markMergedLocked(stored.subject, null);
      await this.adopt(null);
      if (why.includes('account_deletion_pending')) {
        this.emit({ type: 'deletion_pending' });
        throw new KrtuworksError('account_deletion_pending', 'This account is waiting to be deleted.', 403);
      }
      if (why.includes('sanctioned')) {
        this.emit({ type: 'sanctioned', reason: null });
        throw new KrtuworksError('sanctioned', 'The player is banned from this app.', 403);
      }
      this.emit({ type: 'signed_out', reason: why });
      throw signedOut();
    }
  }

  /**
   * Plays as a guest: the device's key, made now if there is none. A new guest needs the age screen's
   * answers (13 or older, the current terms); they are kept and tried again on later launches when the
   * server could not make the guest now. A sign-in the player starts meanwhile wins: this
   * guest is then not used.
   */
  async signInAsGuest(input: { birthDate?: string; acceptedTerms?: string } = {}): Promise<Player> {
    const meta = await this.meta();
    const epoch = meta.epoch;
    if (input.birthDate) {
      meta.guestRequest = { birthDate: input.birthDate, acceptedTerms: input.acceptedTerms ?? CURRENT_TERMS };
      await this.saveMeta(meta);
    }
    const result = await withLock(this.lockName, async () => {
      const current = (await this.ctx.store.get<StoredTokens>(this.key('tokens'))) ?? null;
      if (current) {
        await this.adopt(current);
        return { player: this.player!, created: false, fresh: false };
      }
      const { tokens, created } = await this.deviceKeyGrant((await this.meta()).guestRequest);
      const now = await this.meta();
      if (now.epoch !== epoch) throw new KrtuworksError('context_changed', 'A sign-in started while the guest was being made; the guest was not used.');
      now.guestRequest = null;
      await this.saveMeta(now);
      await this.adopt(tokens);
      return { player: this.player!, created, fresh: true };
    });
    if (result.fresh) this.emit({ type: 'guest', player: result.player, created: result.created });
    return result.player;
  }

  // ── Sign-in with Krtuworks ID (authorization code + PKCE) ─────────────────

  /**
   * The address to send the player to. A guest playing on this device is carried along (`krtu_guest`):
   * a new Krtuworks ID made there IS this guest, and signing in to an existing one folds the guest into
   * it. Starting a sign-in bumps the epoch, so a guest still being made in the background is not used.
   */
  async beginSignIn(options: { redirectUri?: string; carryGuest?: boolean } = {}): Promise<string> {
    const redirectUri = options.redirectUri ?? this.ctx.opts.redirectUri;
    if (!redirectUri) throw new TypeError('redirectUri is needed: one of the client\'s registered redirect addresses');
    const epoch = await withLock(this.lockName, async () => {
      const meta = await this.meta();
      meta.epoch += 1;
      await this.saveMeta(meta);
      return meta.epoch;
    });
    const verifier = randomToken(32);
    const state = randomToken(16);
    const nonce = randomToken(16);
    const params = new URLSearchParams({
      client_id: this.ctx.opts.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: PLAYER_SCOPE,
      // offline_access only counts with prompt=consent (OIDC Core 11); the page shows no consent screen
      // for the app's own players.
      prompt: 'consent',
      resource: DEV_RESOURCE,
      code_challenge: base64Url(await sha256(verifier)),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    if (this.tokens?.kind === 'guest' && options.carryGuest !== false) {
      const key = await this.ctx.store.get<StoredKey>(this.key('deviceKey'));
      if (key?.known) {
        try {
          params.set('krtu_guest', await this.proofWith(key, 'promote'));
        } catch {
          // offline or refused: the sign-in goes on without the guest
        }
      }
    }
    const pending: PendingSignIn = { verifier, nonce, redirectUri, epoch, startedAt: Date.now() };
    await this.ctx.store.set(this.key(`signin:${state}`), pending);
    return `${this.ctx.opts.idOrigin}/oidc/auth?${params}`;
  }

  /** Finishes a sign-in from the address the player came back to. */
  async completeSignIn(callbackUrl: string | URL): Promise<Player> {
    const url = new URL(String(callbackUrl));
    const state = url.searchParams.get('state');
    if (!state) throw new KrtuworksError('invalid_callback', 'The address carries no sign-in.');
    const pending = await this.ctx.store.get<PendingSignIn>(this.key(`signin:${state}`));
    await this.ctx.store.delete(this.key(`signin:${state}`));
    if (!pending || Date.now() - pending.startedAt > PENDING_TTL_MS) throw new KrtuworksError('invalid_callback', 'This sign-in is unknown or too old: start it again.');
    const error = url.searchParams.get('error');
    if (error) throw new KrtuworksError(error, url.searchParams.get('error_description') ?? 'The sign-in did not finish.', 400);
    const iss = url.searchParams.get('iss');
    if (iss !== null && iss !== this.issuer) throw new KrtuworksError('invalid_callback', 'The answer came from another issuer.');
    const code = url.searchParams.get('code');
    if (!code) throw new KrtuworksError('invalid_callback', 'The address carries no code.');
    const answer = await this.token({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier, resource: DEV_RESOURCE });
    if (answer.status !== 200) throw errorOf(answer);
    this.checkIdToken(answer.json?.id_token, pending.nonce);
    const outcome = await withLock(this.lockName, async () => {
      const meta = await this.meta();
      if (meta.epoch !== pending.epoch) throw new KrtuworksError('context_changed', 'Another sign-in started after this one; this one was not used.');
      const before = (await this.ctx.store.get<StoredTokens>(this.key('tokens'))) ?? null;
      const next = this.tokensFrom(answer.json, 'account', before);
      let promoted = false;
      if (before?.kind === 'guest') {
        if (before.subject === next.subject) {
          // The guest became this Krtuworks ID: same player, its key retired by the server.
          promoted = true;
          await this.ctx.store.delete(this.key('deviceKey'));
        } else if (!meta.waitingOwners.includes(before.subject)) {
          // Signed in to an existing account: the guest folds into it once the server confirms.
          meta.waitingOwners.push(before.subject);
        }
      }
      meta.guestRequest = null;
      await this.saveMeta(meta);
      await this.adopt(next);
      return { player: this.player!, promoted };
    });
    this.emit({ type: 'signed_in', player: outcome.player, promoted: outcome.promoted });
    return outcome.player;
  }

  /** OIDC Core 3.1.3.7 for a token straight from the token endpoint over TLS: issuer, audience, nonce, time. */
  private checkIdToken(idToken: unknown, nonce: string): void {
    if (typeof idToken !== 'string') throw new KrtuworksError('invalid_response', 'The sign-in answer carries no ID token.');
    const claims = jwtClaims(idToken);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const fresh = typeof claims.exp === 'number' && claims.exp * 1000 > this.ctx.clock.serverNow() - 60_000;
    if (claims.iss !== this.issuer || !aud.includes(this.ctx.opts.clientId) || claims.nonce !== nonce || !fresh) {
      throw new KrtuworksError('invalid_response', 'The ID token is not for this sign-in.');
    }
  }

  /** Forgets the player on this device (a guest's key stays: signing in as the guest again reaches it). */
  async signOut(): Promise<void> {
    const refreshToken = await withLock(this.lockName, async () => {
      const meta = await this.meta();
      meta.epoch += 1;
      meta.guestRequest = null;
      await this.saveMeta(meta);
      const stored = (await this.ctx.store.get<StoredTokens>(this.key('tokens'))) ?? null;
      await this.adopt(null);
      return stored?.refreshToken ?? null;
    });
    if (refreshToken) {
      const { body, headers } = form({ client_id: this.ctx.opts.clientId, token: refreshToken, token_type_hint: 'refresh_token' });
      await send(this.ctx.fetch, this.ctx.clock, `${this.ctx.opts.idOrigin}/oidc/token/revocation`, { method: 'POST', headers, body }).catch(() => undefined);
    }
    this.emit({ type: 'signed_out', reason: 'signed_out' });
  }
}
