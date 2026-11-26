import type { FamilyData } from './families.js';
import { ANON } from './events.js';
import type { KrtuStore } from './store.js';

export interface LevelRef {
  level: string;
  world?: string;
  part?: string;
}

interface Attempt extends LevelRef {
  /** The player the attempt belongs to. */
  owner: string;
  attempt: number;
  startedAt: number;
  activeAtStart: number;
  deaths: number;
}

type ProgressionEvent = FamilyData['progression'];

/**
 * Levels as the progression family tells them: the game says start, complete, fail,
 * quit, checkpoint and restart; the SDK adds the attempt number (per level and player, kept across
 * launches), the attempt's wall and active seconds and its deaths. An attempt still open when the app
 * goes away is told as a quit.
 */
export class ProgressionTracker {
  private current: Attempt | null = null;

  constructor(
    private readonly store: KrtuStore,
    private readonly clientId: string,
    private readonly owner: () => string,
    private readonly activeSeconds: () => number,
    private readonly emit: (data: ProgressionEvent) => void,
  ) {}

  /** The attempt in play, when it is the present player's: another player's is dropped without a word (nothing is told under the new owner). */
  private live(): Attempt | null {
    const owner = this.owner();
    // Before any player there is only the anonymous one: its level goes on to the first player, like its events.
    if (this.current?.owner === ANON) this.current.owner = owner;
    if (this.current && this.current.owner !== owner) this.current = null;
    return this.current;
  }

  private key(owner: string): string {
    return `krtu:${this.clientId}:levels:${owner}`;
  }

  private ref(level: LevelRef): string {
    return [level.world ?? '', level.level, level.part ?? ''].join('\u0000');
  }

  private times(a: Attempt) {
    return {
      attempt: a.attempt,
      seconds: Math.round((Date.now() - a.startedAt) / 100) / 10,
      activeSeconds: Math.max(0, this.activeSeconds() - a.activeAtStart),
      deaths: a.deaths,
    };
  }

  private place(a: LevelRef) {
    return { level: a.level, ...(a.world ? { world: a.world } : {}), ...(a.part ? { part: a.part } : {}) };
  }

  async start(level: LevelRef): Promise<void> {
    if (this.live()) this.finish('quit');
    const owner = this.owner();
    const counts = (await this.store.get<Record<string, number>>(this.key(owner))) ?? {};
    const ref = this.ref(level);
    counts[ref] = (counts[ref] ?? 0) + 1;
    await this.store.set(this.key(owner), counts);
    if (this.owner() !== owner) return;
    this.current = { ...level, owner, attempt: counts[ref]!, startedAt: Date.now(), activeAtStart: this.activeSeconds(), deaths: 0 };
    this.emit({ action: 'start', ...this.place(level), attempt: this.current.attempt });
  }

  /** Ends the attempt in play (complete, fail or quit). */
  finish(action: 'complete' | 'fail' | 'quit', extra: { score?: number } = {}): void {
    const a = this.live();
    if (!a) return;
    this.current = null;
    this.emit({ action, ...this.place(a), ...this.times(a), ...(extra.score !== undefined ? { score: extra.score } : {}) });
  }

  checkpoint(name: string): void {
    const a = this.live();
    if (!a) return;
    this.emit({ action: 'checkpoint', ...this.place(a), checkpoint: name, ...this.times(a) });
  }

  /** The level starts over: the attempt in play ends as a restart and a new one begins. */
  async restart(): Promise<void> {
    const a = this.live();
    if (!a) return;
    this.current = null;
    this.emit({ action: 'restart', ...this.place(a), ...this.times(a) });
    await this.start(a);
  }

  /** A death counts toward the attempt in play. */
  noteDeath(): LevelRef | null {
    const a = this.live();
    if (!a) return null;
    a.deaths += 1;
    return { level: a.level, world: a.world, part: a.part };
  }

  get inPlay(): LevelRef | null {
    const a = this.live();
    return a ? { level: a.level, world: a.world, part: a.part } : null;
  }
}
