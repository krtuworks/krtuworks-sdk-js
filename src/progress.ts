import type { Api } from './api.js';
import type { ResolvedOptions } from './config.js';
import { KrtuworksError, isKrtuworksError } from './errors.js';
import { base64, uuidV7 } from './ids.js';
import { withLock } from './locks.js';
import type { KrtuStore } from './store.js';

export type StatKind = 'SUM' | 'MAX' | 'MIN' | 'LATEST';
export type SortOrder = 'ASC' | 'DESC';
export type UploadMethod = 'KEEP_BEST' | 'FORCE_UPDATE';

/** What folding a leaderboard's waiting scores needs: which score is better and what a new one does to the stored one. */
export interface BoardRule {
  sortOrder: SortOrder;
  uploadMethod: UploadMethod;
}

interface FrozenOp {
  opId: string;
  type: 'stat' | 'unlock' | 'score';
  key: string;
  value?: number;
  /** Score ops only: base64 of 1-64 bytes. */
  details?: string;
}

/** A value the game reported and not yet frozen into an op: an increase, or a value to keep. */
interface Contribution {
  op: 'add' | 'set';
  value: number;
}

/** A score the game submitted and not yet frozen into an op. */
interface ScoreContribution {
  value: number;
  details?: string;
}

/**
 * Per stat, achievement or leaderboard: the ops frozen with their ids (normally one; a merge can bring
 * a second, which keeps its own id) and what waits behind them.
 */
interface ProgressState {
  stats: Record<string, { inFlight: FrozenOp[]; pending: Contribution[] }>;
  unlocks: Record<string, { inFlight: FrozenOp[]; pending: boolean }>;
  scores: Record<string, { inFlight: FrozenOp[]; pending: ScoreContribution[] }>;
}

export interface ProgressRefusal {
  type: 'stat' | 'unlock' | 'score';
  key: string;
  code: string;
}

const KEY = /^[a-z][a-z0-9_.]{0,63}$/;
const MAX_VALUE = 1e15;
const MAX_OPS = 100;
/** Refusals that say the stat or achievement itself is gone: what waits for it goes too. */
const KEY_GONE = new Set(['unknown_stat', 'stat_retired', 'unknown_achievement', 'achievement_retired']);

/** Refusals that say the leaderboard itself is gone: what waits for it goes too. */
const BOARD_GONE = new Set(['unknown_leaderboard', 'leaderboard_retired']);
const MAX_DETAILS = 64;

const empty = (): ProgressState => ({ stats: {}, unlocks: {}, scores: {} });

/**
 * Folds what waits for one stat into as few values as its kind allows: SUM adds, MAX
 * keeps the largest, MIN the smallest, LATEST the last. A stat whose kind is not known yet only folds
 * its runs of increases; values to keep wait one by one, in order.
 */
export function foldContributions(pending: Contribution[], kind: StatKind | undefined): Contribution[] {
  const out: Contribution[] = [];
  for (const c of pending) {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ ...c });
      continue;
    }
    if (kind === 'SUM' || (kind === undefined && c.op === 'add' && last.op === 'add')) {
      const sum = last.value + c.value;
      if (Math.abs(sum) < MAX_VALUE) {
        last.value = sum;
        last.op = 'add';
        continue;
      }
    } else if (kind === 'MAX') {
      last.value = Math.max(last.value, c.value);
      continue;
    } else if (kind === 'MIN') {
      last.value = Math.min(last.value, c.value);
      continue;
    } else if (kind === 'LATEST') {
      last.value = c.value;
      last.op = c.op;
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

/**
 * Folds what waits for one leaderboard into as few scores as its upload method allows: KEEP_BEST keeps
 * the better one (an equal score keeps the earlier, as the server keeps the stored one), FORCE_UPDATE
 * the last. A board whose rule is not known yet folds nothing: every score waits, in order.
 */
export function foldScores(pending: ScoreContribution[], rule: BoardRule | undefined): ScoreContribution[] {
  if (!rule) return pending.map((c) => ({ ...c }));
  if (rule.uploadMethod === 'FORCE_UPDATE') return pending.length ? [{ ...pending[pending.length - 1]! }] : [];
  let best: ScoreContribution | undefined;
  for (const c of pending) {
    if (!best || (rule.sortOrder === 'DESC' ? c.value > best.value : c.value < best.value)) best = c;
  }
  return best ? [{ ...best }] : [];
}

function findInFlight(state: ProgressState, opId: string): { type: FrozenOp['type']; key: string; entry: { inFlight: FrozenOp[] } } | null {
  const groups: Array<[FrozenOp['type'], Record<string, { inFlight: FrozenOp[] }>]> = [['stat', state.stats], ['unlock', state.unlocks], ['score', state.scores]];
  for (const [type, entries] of groups) {
    for (const [key, entry] of Object.entries(entries)) if (entry.inFlight.some((op) => op.opId === opId)) return { type, key, entry };
  }
  return null;
}

export interface ProgressContext {
  opts: ResolvedOptions;
  store: KrtuStore;
  api: Api;
  subject: () => string | null;
}

/**
 * Stats and achievements: progress is never lost and never
 * counted twice. Every report is written to the store at once; per stat at most one op is in flight,
 * frozen with its opId until it has an answer (sent again unchanged after a failure), and the rest
 * waits folded behind it. Ops have no age limit and do not depend on the statistics choice.
 */
export class ProgressQueue {
  private kinds: Record<string, StatKind> = {};
  private kindsLoaded = false;
  private boards: Record<string, BoardRule> = {};
  private notBefore = 0;
  private backoffMs = 0;
  readonly refusals: ProgressRefusal[] = [];

  constructor(private readonly ctx: ProgressContext) {}

  private key(owner: string): string {
    return `krtu:${this.ctx.opts.clientId}:progress:${owner}`;
  }

  private get kindsKey(): string {
    return `krtu:${this.ctx.opts.clientId}:statKinds`;
  }

  private get boardsKey(): string {
    return `krtu:${this.ctx.opts.clientId}:boardRules`;
  }

  private async load(owner: string): Promise<ProgressState> {
    const state = (await this.ctx.store.get<ProgressState>(this.key(owner))) ?? empty();
    state.scores ??= {};
    return state;
  }

  private async save(owner: string, state: ProgressState): Promise<void> {
    for (const [key, s] of Object.entries(state.stats)) if (!s.inFlight.length && !s.pending.length) delete state.stats[key];
    for (const [key, u] of Object.entries(state.unlocks)) if (!u.inFlight.length && !u.pending) delete state.unlocks[key];
    for (const [key, b] of Object.entries(state.scores)) if (!b.inFlight.length && !b.pending.length) delete state.scores[key];
    if (Object.keys(state.stats).length || Object.keys(state.unlocks).length || Object.keys(state.scores).length) await this.ctx.store.set(this.key(owner), state);
    else await this.ctx.store.delete(this.key(owner));
  }

  /** Loads what the server taught: the stats' kinds and the leaderboards' rules. */
  private async loadKinds(): Promise<void> {
    if (this.kindsLoaded) return;
    this.kinds = (await this.ctx.store.get<Record<string, StatKind>>(this.kindsKey)) ?? {};
    this.boards = (await this.ctx.store.get<Record<string, BoardRule>>(this.boardsKey)) ?? {};
    this.kindsLoaded = true;
  }

  /** Learns the stats' kinds (from `GET /v1/me/progress`): what waits folds tighter from now on. */
  async learnKinds(stats: Array<{ key: string; kind: StatKind }>): Promise<void> {
    await this.loadKinds();
    for (const s of stats) this.kinds[s.key] = s.kind;
    await this.ctx.store.set(this.kindsKey, this.kinds);
  }

  /**
   * Learns the leaderboards' rules (from `GET /v1/me/leaderboards`): what waits folds tighter from now
   * on. A board the server answers without its upload method stays unknown, so nothing folds for it.
   */
  async learnBoards(boards: Array<{ key: string; sortOrder: SortOrder; uploadMethod?: UploadMethod }>): Promise<void> {
    await this.loadKinds();
    for (const b of boards) if (b.uploadMethod) this.boards[b.key] = { sortOrder: b.sortOrder, uploadMethod: b.uploadMethod };
    await this.ctx.store.set(this.boardsKey, this.boards);
  }

  async report(type: 'add' | 'set', key: string, value: number): Promise<void> {
    if (!KEY.test(key)) throw new TypeError(`"${key}" is not a stat key (lowercase letters, digits, _ and ., at most 64)`);
    if (!Number.isFinite(value) || Math.abs(value) >= MAX_VALUE) throw new TypeError('a stat value is a finite number below 10^15');
    await this.loadKinds();
    const owner = this.ctx.subject() ?? 'anon';
    await withLock(this.key(owner), async () => {
      const state = await this.load(owner);
      const entry = (state.stats[key] ??= { inFlight: [], pending: [] });
      entry.pending = foldContributions([...entry.pending, { op: type, value }], this.kinds[key]);
      await this.save(owner, state);
    });
  }

  async submitScore(key: string, value: number, details?: Uint8Array): Promise<void> {
    if (!KEY.test(key)) throw new TypeError(`"${key}" is not a leaderboard key (lowercase letters, digits, _ and ., at most 64)`);
    if (!Number.isInteger(value) || Math.abs(value) >= MAX_VALUE) throw new TypeError('a score is a whole number below 10^15');
    if (details !== undefined && (!(details instanceof Uint8Array) || details.length < 1 || details.length > MAX_DETAILS)) {
      throw new TypeError(`score details are 1-${MAX_DETAILS} bytes`);
    }
    await this.loadKinds();
    const owner = this.ctx.subject() ?? 'anon';
    await withLock(this.key(owner), async () => {
      const state = await this.load(owner);
      const entry = (state.scores[key] ??= { inFlight: [], pending: [] });
      entry.pending = foldScores([...entry.pending, { value, ...(details ? { details: base64(details) } : {}) }], this.boards[key]);
      await this.save(owner, state);
    });
  }

  async unlock(key: string): Promise<void> {
    if (!KEY.test(key)) throw new TypeError(`"${key}" is not an achievement key`);
    const owner = this.ctx.subject() ?? 'anon';
    await withLock(this.key(owner), async () => {
      const state = await this.load(owner);
      const entry = (state.unlocks[key] ??= { inFlight: [], pending: false });
      if (!entry.inFlight.length) entry.pending = true;
      await this.save(owner, state);
    });
  }

  /** How many ops wait for `owner` (in flight or not yet frozen). */
  async waiting(owner: string): Promise<number> {
    const state = await this.load(owner);
    return (
      Object.values(state.stats).reduce((n, s) => n + s.inFlight.length + s.pending.length, 0) +
      Object.values(state.unlocks).reduce((n, u) => n + u.inFlight.length + (u.pending ? 1 : 0), 0) +
      Object.values(state.scores).reduce((n, b) => n + b.inFlight.length + b.pending.length, 0)
    );
  }

  /**
   * Moves `from`'s waiting progress to `to` (the first player after anon play, or a merge target).
   * Everything that waits for `from` is first frozen into ops with ids and written back; only then do the
   * ops move, and an op the target already holds is not added again. The target and the source are two
   * writes: a move cut short between them (the app closed, the delete failed) and run again brings the
   * same ids, so nothing is added twice. One the server already applied under the old account answers
   * `duplicate` under the new one (the merge moved its receipt).
   */
  async move(from: string, to: string): Promise<void> {
    if (from === to) return;
    await this.loadKinds();
    const [first, second] = from < to ? [from, to] : [to, from];
    await withLock(this.key(first), () =>
      withLock(this.key(second), async () => {
        const source = await this.load(from);
        if (this.freezeAll(source)) await this.save(from, source);
        const target = await this.load(to);
        const add = (into: { inFlight: FrozenOp[] }, ops: FrozenOp[]): void => {
          into.inFlight.push(...ops.filter((op) => !into.inFlight.some((held) => held.opId === op.opId)));
        };
        for (const [key, s] of Object.entries(source.stats)) add((target.stats[key] ??= { inFlight: [], pending: [] }), s.inFlight);
        for (const [key, u] of Object.entries(source.unlocks)) {
          const t = (target.unlocks[key] ??= { inFlight: [], pending: false });
          add(t, u.inFlight);
          if (t.inFlight.length) t.pending = false;
        }
        for (const [key, b] of Object.entries(source.scores)) add((target.scores[key] ??= { inFlight: [], pending: [] }), b.inFlight);
        await this.save(to, target);
        await this.ctx.store.delete(this.key(from));
      }),
    );
  }

  /** Freezes everything that waits in `state` into ops with ids (a move's first step); whether anything was. */
  private freezeAll(state: ProgressState): boolean {
    let frozen = false;
    for (const [key, s] of Object.entries(state.stats)) {
      for (const c of foldContributions(s.pending, this.kinds[key])) s.inFlight.push({ opId: uuidV7(), type: 'stat', key, value: c.value });
      frozen ||= s.pending.length > 0;
      s.pending = [];
    }
    for (const [key, u] of Object.entries(state.unlocks)) {
      if (u.pending && !u.inFlight.length) u.inFlight.push({ opId: uuidV7(), type: 'unlock', key });
      frozen ||= u.pending;
      u.pending = false;
    }
    for (const [key, b] of Object.entries(state.scores)) {
      for (const c of foldScores(b.pending, this.boards[key])) b.inFlight.push({ opId: uuidV7(), type: 'score', key, value: c.value, ...(c.details ? { details: c.details } : {}) });
      frozen ||= b.pending.length > 0;
      b.pending = [];
    }
    return frozen;
  }

  /** Freezes the next op of every stat and achievement with none in flight; returns every op to send. */
  private freeze(state: ProgressState): FrozenOp[] {
    const ops: FrozenOp[] = [];
    for (const [key, s] of Object.entries(state.stats)) {
      if (!s.inFlight.length && s.pending.length) {
        s.pending = foldContributions(s.pending, this.kinds[key]);
        const next = s.pending.shift()!;
        s.inFlight.push({ opId: uuidV7(), type: 'stat', key, value: next.value });
      }
      ops.push(...s.inFlight);
    }
    for (const [key, u] of Object.entries(state.unlocks)) {
      if (!u.inFlight.length && u.pending) {
        u.inFlight.push({ opId: uuidV7(), type: 'unlock', key });
        u.pending = false;
      }
      ops.push(...u.inFlight);
    }
    for (const [key, b] of Object.entries(state.scores)) {
      if (!b.inFlight.length && b.pending.length) {
        b.pending = foldScores(b.pending, this.boards[key]);
        const next = b.pending.shift()!;
        b.inFlight.push({ opId: uuidV7(), type: 'score', key, value: next.value, ...(next.details ? { details: next.details } : {}) });
      }
      ops.push(...b.inFlight);
    }
    return ops.slice(0, MAX_OPS);
  }

  /**
   * Sends the signed-in player's ops until nothing waits or a send fails. Answers per op: applied and
   * duplicate end the op; a refusal for good ends it too (and everything waiting for a stat,
   * achievement or leaderboard that no longer exists); anything else keeps it frozen for the next flush.
   * A score refused `module_disabled` stays frozen too: the owner may switch the module on again.
   */
  async flush(): Promise<{ applied: number; stoppedBy: string | null; values: Record<string, number> }> {
    const owner = this.ctx.subject();
    const out = { applied: 0, stoppedBy: null as string | null, values: {} as Record<string, number> };
    if (!owner) return { ...out, stoppedBy: 'signed_out' };
    if (Date.now() < this.notBefore) return { ...out, stoppedBy: 'waiting' };
    await this.loadKinds();
    for (let round = 0; round < 50; round += 1) {
      const ops = await withLock(this.key(owner), async () => {
        const state = await this.load(owner);
        const frozen = this.freeze(state);
        await this.save(owner, state);
        return frozen;
      });
      if (!ops.length) return out;
      let answer;
      try {
        answer = await this.ctx.api.player('/v1/me/progress', {
          method: 'POST',
          json: { platform: this.ctx.opts.platform, build: this.ctx.opts.build, ops },
          owner,
        });
      } catch (err) {
        if (!isKrtuworksError(err)) throw err;
        this.backoff(err);
        out.stoppedBy = err.code;
        return out;
      }
      this.backoffMs = 0;
      const results = (answer.json?.results as Array<{ opId: string; status: string; code?: string; value?: number }>) ?? [];
      const settled = await withLock(this.key(owner), async () => {
        const state = await this.load(owner);
        let count = 0;
        for (const r of results) {
          // A refusal carries the key but not the type, and op_id_reused neither: the op is found by its id.
          const hit = findInFlight(state, r.opId);
          if (!hit) continue;
          const { type, key, entry } = hit;
          if (r.status === 'rejected' && type === 'score' && r.code === 'module_disabled') {
            out.stoppedBy = 'module_disabled';
            continue;
          }
          entry.inFlight = entry.inFlight.filter((op) => op.opId !== r.opId);
          count += 1;
          if (r.status === 'rejected') {
            this.refusals.push({ type, key, code: r.code ?? 'rejected' });
            if (type === 'score' ? BOARD_GONE.has(r.code ?? '') : KEY_GONE.has(r.code ?? '')) {
              if (type === 'unlock') delete state.unlocks[key];
              else if (type === 'score') delete state.scores[key];
              else delete state.stats[key];
            }
          } else {
            out.applied += 1;
            if (type === 'stat' && typeof r.value === 'number') out.values[key] = r.value;
          }
        }
        await this.save(owner, state);
        return count;
      });
      if (!settled) {
        // An answer that settles none of the ops sent: keep them frozen and try again later.
        out.stoppedBy ??= 'unanswered';
        return out;
      }
    }
    return out;
  }

  private backoff(err: KrtuworksError): void {
    this.backoffMs = Math.min(300_000, Math.max(5_000, this.backoffMs * 2));
    this.notBefore = Date.now() + (err.retryAfter !== null ? err.retryAfter * 1000 : this.backoffMs);
  }

  resetBackoff(): void {
    this.notBefore = 0;
    this.backoffMs = 0;
  }
}
