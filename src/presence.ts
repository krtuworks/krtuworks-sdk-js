import type { Api } from './api.js';
import type { KrtuStore } from './store.js';

export type PresenceReason =
  | 'no_platform'
  | 'not_game'
  | 'module_disabled'
  | 'hidden'
  | 'unknown_state'
  | 'param_missing'
  | 'states_unknown'
  | 'platform_rejected';

export interface PresenceResult {
  applied: boolean;
  reason?: PresenceReason;
}

export interface PresenceState {
  key: string;
  token: string;
  /** The parameter names the state's text needs. */
  params: string[];
}

interface Stored {
  etag: string | null;
  states: PresenceState[] | null;
  visible: boolean | null;
}

/**
 * The rich presence states the owner declared and whether the player shows their presence (the server
 * `/v1/me/presence-states`, `/v1/me/presence-visibility`), kept per player in the store and revalidated
 * with the ETag. A browser has no platform presence to write, so a call that passes every rule ends in
 * `no_platform`.
 */
export class Presence {
  private cached: { subject: string; value: Stored } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly store: KrtuStore,
    private readonly api: Api,
    private readonly subject: () => string | null,
  ) {}

  private key(subject: string): string {
    return `krtu:${this.clientId}:presence:${subject}`;
  }

  /** Reads the current player's kept copy. */
  async load(): Promise<void> {
    const subject = this.subject();
    this.cached = subject ? { subject, value: (await this.store.get<Stored>(this.key(subject))) ?? { etag: null, states: null, visible: null } } : null;
  }

  /** The player changed or signed out: nothing of the old player stays in memory. */
  forget(): void {
    this.cached = null;
  }

  private current(): Stored | null {
    return this.cached && this.cached.subject === this.subject() ? this.cached.value : null;
  }

  states(): PresenceState[] | null {
    return this.current()?.states ?? null;
  }

  visible(): boolean | null {
    return this.current()?.visible ?? null;
  }

  private async keep(subject: string, value: Stored): Promise<void> {
    this.cached = { subject, value };
    await this.store.set(this.key(subject), value);
  }

  /** Asks the server for the states and the choice (If-None-Match: a 304 keeps the kept copy). */
  async refresh(): Promise<void> {
    const subject = this.subject();
    if (!subject) return;
    if (this.cached?.subject !== subject) await this.load();
    const held = this.current();
    const answer = await this.api.player('/v1/me/presence-states', {
      headers: held?.etag ? { 'if-none-match': held.etag } : {},
      accept: [304],
    });
    if (answer.status === 304 || !held) return;
    await this.keep(subject, {
      etag: answer.headers.get('etag'),
      states: (answer.json?.states as PresenceState[] | undefined) ?? [],
      visible: answer.json?.visible === true,
    });
  }

  async setVisible(visible: boolean): Promise<void> {
    const subject = this.subject();
    const answer = await this.api.player('/v1/me/presence-visibility', { method: 'PUT', json: { visible } });
    if (!subject) return;
    if (this.cached?.subject !== subject) await this.load();
    await this.keep(subject, { ...(this.current() ?? { etag: null, states: null }), visible: answer.json?.visible === true });
  }

  /**
   * The first rule a call breaks, or null when it passes them all: the state is declared and every
   * parameter it declares has a non-empty value (the caller's, else the built-in one). Undeclared extras
   * are dropped with a log line.
   */
  check(key: string, given: Record<string, string | number>, builtins: Record<string, () => string | null>, log: (line: string) => void): PresenceReason | null {
    if (this.visible() === false) return 'hidden';
    const states = this.states();
    if (!states) return 'states_unknown';
    const state = states.find((s) => s.key === key);
    if (!state) return 'unknown_state';
    const extra = Object.keys(given).filter((name) => !state.params.includes(name));
    if (extra.length) log(`presence ${key}: dropped undeclared params ${extra.join(', ')}`);
    for (const name of state.params) {
      const value = Object.prototype.hasOwnProperty.call(given, name) ? String(given[name]) : (builtins[name]?.() ?? '');
      if (value === '') return 'param_missing';
    }
    return null;
  }
}
