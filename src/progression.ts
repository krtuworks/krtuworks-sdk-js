import type { FamilyData } from './families.js';
import type { KrtuStore } from './store.js';

export interface LevelRef {
  level: string;
  world?: string;
  part?: string;
}

interface Attempt extends LevelRef {
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

  private key(): string {
    return `krtu:${this.clientId}:levels:${this.owner()}`;
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
    if (this.current) this.finish('quit');
    const counts = (await this.store.get<Record<string, number>>(this.key())) ?? {};
    const ref = this.ref(level);
    counts[ref] = (counts[ref] ?? 0) + 1;
    await this.store.set(this.key(), counts);
    this.current = { ...level, attempt: counts[ref]!, startedAt: Date.now(), activeAtStart: this.activeSeconds(), deaths: 0 };
    this.emit({ action: 'start', ...this.place(level), attempt: this.current.attempt });
  }

  /** Ends the attempt in play (complete, fail or quit). */
  finish(action: 'complete' | 'fail' | 'quit', extra: { score?: number } = {}): void {
    const a = this.current;
    if (!a) return;
    this.current = null;
    this.emit({ action, ...this.place(a), ...this.times(a), ...(extra.score !== undefined ? { score: extra.score } : {}) });
  }

  checkpoint(name: string): void {
    const a = this.current;
    if (!a) return;
    this.emit({ action: 'checkpoint', ...this.place(a), checkpoint: name, ...this.times(a) });
  }

  /** The level starts over: the attempt in play ends as a restart and a new one begins. */
  async restart(): Promise<void> {
    const a = this.current;
    if (!a) return;
    this.current = null;
    this.emit({ action: 'restart', ...this.place(a), ...this.times(a) });
    await this.start(a);
  }

  /** A death counts toward the attempt in play. */
  noteDeath(): LevelRef | null {
    if (!this.current) return null;
    this.current.deaths += 1;
    return { level: this.current.level, world: this.current.world, part: this.current.part };
  }

  get inPlay(): LevelRef | null {
    return this.current ? { level: this.current.level, world: this.current.world, part: this.current.part } : null;
  }
}
