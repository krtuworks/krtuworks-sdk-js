import type { Api } from './api.js';
import type { ResolvedOptions } from './config.js';
import { KrtuworksError, WAITING_BACKOFF_MS, isKrtuworksError } from './errors.js';
import { uuidV4 } from './ids.js';

export interface SessionInfo {
  id: string;
  /** The player the session is for. */
  owner: string;
  startedAt: string;
}

/**
 * The play session: opened once per launch and player, kept alive every
 * `heartbeatSeconds` with the time actually in use (foreground only), ended when the app goes away.
 * An open whose answer was lost is sent again with the same `clientSessionId` and gets the same session.
 */
export class SessionKeeper {
  private current: SessionInfo | null = null;
  private clientSessionId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatSeconds = 60;
  private activeMs = 0;
  private activeSince: number | null = performance.now();
  /** The launch's time in use when the current session began: the server counts only what follows. */
  private sessionBaseMs = 0;
  private opening: Promise<SessionInfo | null> | null = null;
  /** The player the open in flight is for. */
  private openingFor: string | null = null;
  /** The app wants a session (`start` ran): a failed open is tried again until one is open or `close`. */
  private wanted = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 0;

  constructor(
    private readonly opts: ResolvedOptions,
    private readonly api: Api,
    private readonly subject: () => string | null,
    /** Told the licence list of a session answer (only an open that sent a platform proof gets one). */
    private readonly onEntitlements: (items: unknown) => Promise<void> = async () => undefined,
  ) {}

  get session(): SessionInfo | null {
    const owner = this.subject();
    return this.current && this.current.owner === owner ? this.current : null;
  }

  private launchActiveMs(): number {
    const live = this.activeSince !== null ? performance.now() - this.activeSince : 0;
    return this.activeMs + live;
  }

  /** Seconds in use in this launch (foreground only). */
  activeSeconds(): number {
    return Math.floor(this.launchActiveMs() / 1000);
  }

  /**
   * Seconds in use since the current session began (foreground only): what the session reports. A session
   * opened after another one (a new player, a timeout) starts from zero, not from the launch's total.
   */
  sessionActiveSeconds(): number {
    return Math.floor(Math.max(0, this.launchActiveMs() - this.sessionBaseMs) / 1000);
  }

  setForeground(foreground: boolean): void {
    if (foreground && this.activeSince === null) this.activeSince = performance.now();
    if (!foreground && this.activeSince !== null) {
      this.activeMs += performance.now() - this.activeSince;
      this.activeSince = null;
    }
  }

  /** Opens the player's session if there is none (one at a time). */
  async open(): Promise<SessionInfo | null> {
    if (this.session) return this.session;
    if (this.opening && this.openingFor !== this.subject()) {
      // The open in flight is another player's: its answer is not this player's session.
      await this.opening.catch(() => undefined);
      return this.open();
    }
    this.openingFor = this.subject();
    this.opening ??= this.doOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /**
   * Opens the session and keeps trying: a launch that is offline, a busy server or a refusal that can lift
   * leaves no session for the whole run otherwise. A failed open is tried again with a growing wait (the
   * server's Retry-After first), at the next `ensure` (a flush, the browser coming back online) and until `close`.
   */
  async start(): Promise<SessionInfo | null> {
    this.wanted = true;
    this.cancelRetry();
    try {
      const session = await this.open();
      if (session) this.retryMs = 0;
      return session;
    } catch (err) {
      this.scheduleRetry(isKrtuworksError(err) ? err : null);
      return null;
    }
  }

  /** Tries a failed open again now when none is waiting for its time (a flush, the page back online). */
  ensure(force = false): void {
    if (!this.wanted || this.session || this.opening || !this.subject()) return;
    if (this.retryTimer && !force) return;
    void this.start();
  }

  private scheduleRetry(err: KrtuworksError | null): void {
    if (!this.wanted || this.retryTimer) return;
    this.retryMs = Math.min(300_000, Math.max(15_000, this.retryMs * 2));
    const wait = err?.retryAfter != null ? err.retryAfter * 1000 : err?.waiting ? WAITING_BACKOFF_MS : this.retryMs;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.ensure();
    }, wait);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async doOpen(): Promise<SessionInfo | null> {
    const owner = this.subject();
    if (!owner) return null;
    if (this.current && this.current.owner !== owner) this.reset();
    if (!this.clientSessionId) {
      // A new session (not an open sent again after a lost answer): its time in use starts now.
      this.clientSessionId = uuidV4();
      this.sessionBaseMs = this.launchActiveMs();
    }
    const device = this.opts.device ?? undefined;
    const answer = await this.api.player('/v1/sessions', {
      method: 'POST',
      json: {
        clientSessionId: this.clientSessionId,
        platform: this.opts.platform,
        build: this.opts.build,
        ...(device ? { device } : {}),
        ...(this.opts.locale ? { locale: this.opts.locale } : {}),
      },
      owner,
    });
    const session = answer.json?.session as { id: string; startedAt: string } | undefined;
    if (!session || this.subject() !== owner) return null;
    this.current = { id: session.id, owner, startedAt: session.startedAt };
    await this.onEntitlements(answer.json?.entitlements).catch(() => undefined);
    if (typeof answer.json?.heartbeatSeconds === 'number') this.heartbeatSeconds = answer.json.heartbeatSeconds;
    this.schedule();
    return this.current;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.heartbeat().catch(() => undefined), this.heartbeatSeconds * 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async heartbeat(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      const answer = await this.api.player(`/v1/sessions/${session.id}/heartbeat`, {
        method: 'POST',
        json: { activeSeconds: this.sessionActiveSeconds(), foreground: this.activeSince !== null },
        owner: session.owner,
      });
      const next = answer.json?.nextHeartbeatSeconds;
      if (typeof next === 'number' && next > 0) this.heartbeatSeconds = next;
    } catch (err) {
      if (isKrtuworksError(err) && (err.code === 'session_ended' || err.code === 'session_not_found')) {
        // The server closed it (30 minutes without a heartbeat): a new one, with a new id.
        this.current = null;
        this.clientSessionId = null;
        await this.start();
        return;
      }
    } finally {
      if (this.current) this.schedule();
    }
  }

  /** One whole session where every step must answer: open, a heartbeat, end (the validator's round). */
  async round(): Promise<void> {
    const session = await this.open();
    if (!session) throw new KrtuworksError('signed_out', 'No player is signed in.');
    let failure: unknown = null;
    try {
      await this.api.player(`/v1/sessions/${session.id}/heartbeat`, {
        method: 'POST',
        json: { activeSeconds: this.sessionActiveSeconds(), foreground: this.activeSince !== null },
        owner: session.owner,
      });
    } catch (err) {
      failure = err;
    }
    this.close();
    // The session is ended even when its heartbeat failed, so the round leaves nothing open.
    const ended = this.api.player(`/v1/sessions/${session.id}/end`, { method: 'POST', json: { activeSeconds: this.sessionActiveSeconds() }, owner: session.owner });
    if (failure) {
      await ended.catch(() => undefined);
      throw failure;
    }
    await ended;
  }

  /** Ends the session (on pagehide the request outlives the page). */
  async end(): Promise<void> {
    const session = this.session;
    this.close();
    if (!session) return;
    await this.api
      .player(`/v1/sessions/${session.id}/end`, { method: 'POST', json: { activeSeconds: this.sessionActiveSeconds() }, keepalive: true, owner: session.owner })
      .catch(() => undefined);
  }

  /** Forgets the session without telling the server (the player changed: it times out there). */
  close(): void {
    this.reset();
    this.wanted = false;
    this.retryMs = 0;
    this.cancelRetry();
  }

  private reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    this.clientSessionId = null;
  }
}
