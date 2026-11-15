import type { Api } from './api.js';
import { GAME_MODULES, MODULES, type Module, type ResolvedOptions } from './config.js';
import type { KrtuStore } from './store.js';

export interface Switch {
  build: string;
  mode: 'TELEMETRY' | 'ALL';
  message: string;
}

export interface RemoteConfigValue {
  appId: string;
  environment: string;
  platform: string | null;
  version: string;
  config: Record<string, unknown> & {
    maintenance?: { enabled: boolean; message?: string | null };
    minVersion?: string | null;
    modules?: Partial<Record<Module, boolean>>;
  };
  switches: Switch[];
  serverTime: string;
}

interface Stored {
  etag: string | null;
  value: RemoteConfigValue;
}

/**
 * The app's remote config, read without a sign-in and revalidated with its ETag. The
 * last good copy is kept in the store, so an offline launch starts with what the owner set last.
 */
export class RemoteConfig {
  private stored: Stored | null = null;

  constructor(
    private readonly opts: ResolvedOptions,
    private readonly api: Api,
    private readonly store: KrtuStore,
  ) {}

  private get key(): string {
    return `krtu:${this.opts.clientId}:config:${this.opts.platform}`;
  }

  async load(): Promise<RemoteConfigValue | null> {
    this.stored = (await this.store.get<Stored>(this.key)) ?? null;
    return this.value;
  }

  get value(): RemoteConfigValue | null {
    return this.stored?.value ?? null;
  }

  /** Asks the server; `false` when nothing changed. Throws when it cannot (the kept copy stays). */
  async refresh(): Promise<boolean> {
    const answer = await this.api.open(`/v1/apps/${encodeURIComponent(this.opts.slug)}/config`, {
      // The build rides in the query (no header: a browser's read stays a simple GET) and counts for its release report.
      query: { environment: this.opts.environment, platform: this.opts.platform, build: this.opts.build },
      headers: this.stored?.etag ? { 'if-none-match': this.stored.etag } : {},
      accept: [304],
    });
    if (answer.status === 304) return false;
    this.stored = { etag: answer.headers.get('etag'), value: answer.json as unknown as RemoteConfigValue };
    await this.store.set(this.key, this.stored);
    return true;
  }

  /** A module the owner switched off makes nothing; a switch never set is on. An app that is not a game has no game-only modules. */
  moduleOn(module: Module): boolean {
    if (!this.opts.game && GAME_MODULES.includes(module)) return false;
    return this.value?.config.modules?.[module] !== false;
  }

  modules(): Record<Module, boolean> {
    return Object.fromEntries(MODULES.map((m) => [m, this.moduleOn(m)])) as Record<Module, boolean>;
  }

  /** The owner's switch that rules this build, ALL over TELEMETRY. */
  switchForBuild(): Switch | null {
    const mine = (this.value?.switches ?? []).filter((s) => s.build === '*' || s.build === this.opts.build);
    return mine.find((s) => s.mode === 'ALL') ?? mine.find((s) => s.mode === 'TELEMETRY') ?? null;
  }

  get<T = unknown>(key: string, fallback?: T): T | undefined {
    const config = this.value?.config;
    return config && Object.prototype.hasOwnProperty.call(config, key) ? (config[key] as T) : fallback;
  }
}

/** True when `build` is older than `minVersion` (dotted numbers; a build's `+meta` is ignored). */
export function olderThan(build: string, minVersion: string): boolean {
  const parts = (v: string) => v.split('+')[0]!.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const a = parts(build);
  const b = parts(minVersion);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}
