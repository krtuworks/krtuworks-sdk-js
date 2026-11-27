import type { Api } from './api.js';
import type { KrtuStore } from './store.js';

/** One licence of the player in this app: the game itself (`sku` base) or one of its DLCs (the DLC's product key). */
export interface Entitlement {
  sku: string;
  source: string;
  /** null: the server never saw a licence (a DLC the player never owned). */
  status: 'ACTIVE' | 'REVOKED' | null;
  /** The platform's id the licence is read for (a Steam AppID); null when the server has none. */
  platformProductId: string | null;
  /** The server checked it with the platform in this launch (the session's answer). */
  checked: boolean;
}

type Stored = Omit<Entitlement, 'checked'>;

/** Reads the server's items (`entitlements` of a session answer, the list of `GET /v1/me/entitlements`); anything else is ignored. */
function itemsOf(value: unknown): Entitlement[] {
  if (!Array.isArray(value)) return [];
  const items: Entitlement[] = [];
  for (const raw of value as Array<Record<string, unknown> | null>) {
    if (!raw || typeof raw.sku !== 'string' || typeof raw.source !== 'string') continue;
    items.push({
      sku: raw.sku,
      source: raw.source,
      status: raw.status === 'ACTIVE' || raw.status === 'REVOKED' ? raw.status : null,
      platformProductId: typeof raw.platformProductId === 'string' ? raw.platformProductId : null,
      checked: raw.checked === true,
    });
  }
  return items;
}

/**
 * What the player owns (the server `entitlements`): the game's licence and its DLCs, as the server last said.
 * Kept per player and environment in the store (the last answer of an earlier launch stays when the
 * server cannot be reached). `ownsDlc` reads, in this order: what the server confirmed with the
 * platform in this launch (a session answer item with `checked`), then the platform client's own answer
 * (a browser has none), then the last answer the server gave, kept from an earlier launch or fetched.
 */
export class Entitlements {
  private cached: { subject: string; stored: Stored[]; confirmed: Map<string, Entitlement> } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly store: KrtuStore,
    private readonly api: Api,
    private readonly subject: () => string | null,
  ) {}

  private key(subject: string): string {
    return `krtu:${this.clientId}:entitlements:${subject}`;
  }

  /** Reads the current player's kept list. */
  async load(): Promise<void> {
    const subject = this.subject();
    if (!subject) {
      this.cached = null;
      return;
    }
    const stored = (await this.store.get<Stored[]>(this.key(subject))) ?? [];
    // The player changed while the list was read: that player's own read fills the cache.
    if (this.subject() === subject) this.cached = { subject, stored, confirmed: new Map() };
  }

  /** Reads the kept list unless this player's is already held (a launch's confirmed answers stay). */
  async ensureLoaded(): Promise<void> {
    if (this.subject() && this.cached?.subject !== this.subject()) await this.load();
  }

  /** The player changed or signed out: nothing of the old player stays in memory. */
  forget(): void {
    this.cached = null;
  }

  private current(): NonNullable<Entitlements['cached']> | null {
    return this.cached && this.cached.subject === this.subject() ? this.cached : null;
  }

  /** The licences as known now: the server's last answer, with `checked` on what it confirmed in this launch. */
  list(): Entitlement[] {
    const held = this.current();
    return held ? held.stored.map((s) => held.confirmed.get(s.sku) ?? { ...s, checked: false }) : [];
  }

  private async keep(held: NonNullable<Entitlements['cached']>, stored: Stored[]): Promise<void> {
    held.stored = stored;
    await this.store.set(this.key(held.subject), stored);
  }

  /** The session answer's list: its checked items are this launch's confirmed answers, the whole list the server's last word. */
  async fromSession(value: unknown): Promise<void> {
    const subject = this.subject();
    const items = itemsOf(value);
    if (!subject || !items.length) return;
    await this.ensureLoaded();
    const held = this.current();
    if (!held || held.subject !== subject) return;
    held.confirmed = new Map(items.filter((i) => i.checked).map((i) => [i.sku, i]));
    await this.keep(held, items.map(({ checked: _checked, ...rest }) => rest));
  }

  /** `GET /v1/me/entitlements`: the stored licences replace what the kept list says (a DLC it no longer holds is kept as `null`, for its id). */
  async refresh(): Promise<Entitlement[]> {
    const subject = this.subject();
    if (!subject) return [];
    await this.ensureLoaded();
    const answer = await this.api.player('/v1/me/entitlements', { owner: subject });
    const held = this.current();
    if (!held || held.subject !== subject) return [];
    const items = itemsOf(answer.json?.entitlements);
    const listed = new Set(items.map((i) => i.sku));
    const unlisted = held.stored.filter((s) => !listed.has(s.sku)).map((s) => ({ ...s, status: null }));
    await this.keep(held, [...items.map(({ checked: _checked, ...rest }) => rest), ...unlisted]);
    return this.list();
  }

  /**
   * Whether the player owns the DLC `key` (its product key). `local` is the platform client's own
   * answer for the DLC's platform id (Steam's), when the platform has one.
   */
  ownsDlc(key: string, local?: (platformProductId: string) => boolean | null): boolean {
    const held = this.current();
    const kept = held?.stored.find((s) => s.sku === key);
    const confirmed = held?.confirmed.get(key);
    if (confirmed) return confirmed.status === 'ACTIVE';
    if (local && kept?.platformProductId) {
      const said = local(kept.platformProductId);
      if (said !== null) return said;
    }
    return kept?.status === 'ACTIVE';
  }
}
