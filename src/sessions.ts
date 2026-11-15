import type { Api } from './api.js';
import type { ResolvedOptions } from './config.js';
import { KrtuworksError, isKrtuworksError } from './errors.js';
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
  private opening: Promise<SessionInfo | null> | null = null;

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

  /** Seconds in use in this launch (foreground only). */
  activeSeconds(): number {
    const live = this.activeSince !== null ? performance.now() - this.activeSince : 0;
    return Math.floor((this.activeMs + live) / 1000);
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
    this.opening ??= this.doOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpen(): Promise<SessionInfo | null> {
    const owner = this.subject();
    if (!owner) return null;
    if (this.current && this.current.owner !== owner) this.close();
    this.clientSessionId ??= uuidV4();
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
        json: { activeSeconds: this.activeSeconds(), foreground: this.activeSince !== null },
      });
      const next = answer.json?.nextHeartbeatSeconds;
      if (typeof next === 'number' && next > 0) this.heartbeatSeconds = next;
    } catch (err) {
      if (isKrtuworksError(err) && (err.code === 'session_ended' || err.code === 'session_not_found')) {
        // The server closed it (30 minutes without a heartbeat): a new one, with a new id.
        this.current = null;
        this.clientSessionId = null;
        await this.open().catch(() => undefined);
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
        json: { activeSeconds: this.activeSeconds(), foreground: this.activeSince !== null },
      });
    } catch (err) {
      failure = err;
    }
    this.close();
    // The session is ended even when its heartbeat failed, so the round leaves nothing open.
    const ended = this.api.player(`/v1/sessions/${session.id}/end`, { method: 'POST', json: { activeSeconds: this.activeSeconds() } });
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
      .player(`/v1/sessions/${session.id}/end`, { method: 'POST', json: { activeSeconds: this.activeSeconds() }, keepalive: true })
      .catch(() => undefined);
  }

  /** Forgets the session without telling the server (the player changed: it times out there). */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    this.clientSessionId = null;
  }
}
