import type { Api } from './api.js';
import type { Clock } from './clock.js';
import type { ResolvedOptions } from './config.js';
import { KrtuworksError, isKrtuworksError } from './errors.js';
import { uuidV7 } from './ids.js';
import { withLock } from './locks.js';
import type { KrtuStore } from './store.js';

export interface EventPosition {
  space: 'world' | 'screen';
  area: string;
  x: number;
  y: number;
  z?: number;
}

/** An event as `/v1/events` takes it. */
export interface WireEvent {
  id: string;
  type: string;
  createdAt: string;
  launchId: string;
  monotonicMs: number;
  serverOffsetMs?: number;
  sessionId?: string;
  build?: string;
  schemaVersion?: number;
  position?: EventPosition;
  data?: Record<string, unknown>;
}

/** A batch frozen before its first send: the same id always carries the same platform, build and events. */
interface FrozenBatch {
  batchId: string;
  platform: string;
  build: string;
  events: WireEvent[];
}

interface QueueState {
  pending: WireEvent[];
  batch: FrozenBatch | null;
  /** Events dropped here (queue full, too old, refused); the count is reported once with an error event. */
  dropped: number;
  reported: number;
}

export const ANON = 'anon';
const MAX_EVENTS = 50_000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_AGE_MS = 30 * 86_400_000;
const BATCH_EVENTS = 500;
/** The server reads at most 256 KB as sent; batches are built well under it and halved when gzip still overshoots. */
const SENT_LIMIT = 250 * 1024;
const RAW_LIMIT_GZIP = 1_500_000;

const encoder = new TextEncoder();
const sizeOf = (e: WireEvent): number => encoder.encode(JSON.stringify(e)).length;

async function gzip(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface EventQueueContext {
  opts: ResolvedOptions;
  store: KrtuStore;
  clock: Clock;
  api: Api;
  /** Who the events are sent as now (null: nobody signed in). */
  subject: () => string | null;
}

export interface FlushResult {
  sent: number;
  rejected: Array<{ id: string; code: string }>;
  /** Why the queue stopped early (network_error, switched_off …), null when it emptied. */
  stoppedBy: string | null;
}

/**
 * Telemetry events: every event is made with its id and
 * bound to the player it is about (`anon` before any account; that queue goes to the first player).
 * Queued events are written to the store before they are sent; a batch is frozen before its first send
 * and sent again unchanged after a failure; each event's answer is read on its own: accepted, duplicate
 * and rejected leave the queue, retry goes back with its id into a new batch.
 */
export class EventQueue {
  private buffer: Array<{ owner: string; event: WireEvent }> = [];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private notBefore = 0;
  private backoffMs = 0;

  constructor(private readonly ctx: EventQueueContext) {}

  private key(owner: string): string {
    return `krtu:${this.ctx.opts.clientId}:events:${owner}`;
  }

  private lock(owner: string): string {
    return `krtu:${this.ctx.opts.clientId}:events:${owner}`;
  }

  private async load(owner: string): Promise<QueueState> {
    return (await this.ctx.store.get<QueueState>(this.key(owner))) ?? { pending: [], batch: null, dropped: 0, reported: 0 };
  }

  private async save(owner: string, state: QueueState): Promise<void> {
    if (!state.pending.length && !state.batch && state.dropped === state.reported) await this.ctx.store.delete(this.key(owner));
    else await this.ctx.store.set(this.key(owner), state);
  }

  /** Makes an event now, for whoever plays now. Kept in memory for a moment, then written to the store. */
  add(event: Omit<WireEvent, 'id' | 'createdAt' | 'launchId' | 'monotonicMs' | 'serverOffsetMs'>): WireEvent {
    const made: WireEvent = {
      id: uuidV7(),
      createdAt: new Date().toISOString(),
      launchId: this.ctx.clock.launchId,
      monotonicMs: this.ctx.clock.monotonicMs(),
      ...(this.ctx.clock.serverOffsetMs !== null ? { serverOffsetMs: Math.round(this.ctx.clock.serverOffsetMs) } : {}),
      ...event,
    };
    this.buffer.push({ owner: this.ctx.subject() ?? ANON, event: made });
    this.persistTimer ??= setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch(() => undefined);
    }, 1000);
    return made;
  }

  /** Writes the events made since the last write; drops the oldest when the queue is full or too old. */
  async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const taken = this.buffer;
    this.buffer = [];
    const byOwner = new Map<string, WireEvent[]>();
    for (const { owner, event } of taken) byOwner.set(owner, [...(byOwner.get(owner) ?? []), event]);
    for (const [owner, events] of byOwner) {
      await withLock(this.lock(owner), async () => {
        const state = await this.load(owner);
        state.pending.push(...events);
        this.trim(state);
        await this.save(owner, state);
      });
    }
  }

  private trim(state: QueueState): void {
    const oldest = Date.now() - MAX_AGE_MS;
    const before = state.pending.length;
    state.pending = state.pending.filter((e) => Date.parse(e.createdAt) >= oldest);
    let bytes = state.pending.reduce((n, e) => n + sizeOf(e), 0) + (state.batch?.events.reduce((n, e) => n + sizeOf(e), 0) ?? 0);
    let count = state.pending.length + (state.batch?.events.length ?? 0);
    let cut = 0;
    while (state.pending.length > cut && (count > MAX_EVENTS || bytes > MAX_BYTES)) {
      bytes -= sizeOf(state.pending[cut]!);
      count -= 1;
      cut += 1;
    }
    state.pending = state.pending.slice(cut);
    state.dropped += before - state.pending.length;
  }

  /** Events waiting for `owner` (written and not yet written). */
  async size(owner: string): Promise<number> {
    const state = await this.load(owner);
    return state.pending.length + (state.batch?.events.length ?? 0) + this.buffer.filter((b) => b.owner === owner).length;
  }

  /**
   * Moves `from`'s queue to `to`: the events made before any account go to the first player; a merged
   * account's go to the one it went into (the server counts each event once by its id, and a batch it
   * took under the old account answers the same under the new one).
   */
  async move(from: string, to: string): Promise<void> {
    if (from === to) return;
    await this.persist();
    const [first, second] = from < to ? [from, to] : [to, from];
    await withLock(this.lock(first), () =>
      withLock(this.lock(second), async () => {
        const source = await this.load(from);
        if (!source.pending.length && !source.batch && source.dropped === source.reported) return;
        // The dropped count leaves the source before it reaches the target: a move cut short between
        // the writes loses it rather than says it twice.
        const unsaid = source.dropped - source.reported;
        if (unsaid > 0) {
          source.reported = source.dropped;
          await this.save(from, source);
        }
        const target = await this.load(to);
        // A move run again after it was cut short brings events the target holds already: they go once.
        const held = new Set([...target.pending, ...(target.batch?.events ?? [])].map((e) => e.id));
        if (source.batch && source.batch.batchId !== target.batch?.batchId) {
          if (target.batch) target.pending.unshift(...source.batch.events.filter((e) => !held.has(e.id)));
          else target.batch = source.batch;
        }
        target.pending.push(...source.pending.filter((e) => !held.has(e.id)));
        target.dropped += Math.max(0, unsaid);
        this.trim(target);
        await this.save(to, target);
        await this.ctx.store.delete(this.key(from));
      }),
    );
  }

  private freeze(state: QueueState, limit: number): FrozenBatch | null {
    if (!state.pending.length) return null;
    const gzipOk = typeof CompressionStream !== 'undefined';
    const raw = gzipOk ? RAW_LIMIT_GZIP : SENT_LIMIT;
    const events: WireEvent[] = [];
    let bytes = 0;
    for (const e of state.pending) {
      const size = sizeOf(e) + 1;
      if (events.length >= limit || (events.length > 0 && bytes + size > raw)) break;
      events.push(e);
      bytes += size;
    }
    state.pending = state.pending.slice(events.length);
    return { batchId: uuidV7(), platform: this.ctx.opts.platform, build: this.ctx.opts.build, events };
  }

  /** The dropped-events count, said once as an SDK error event (if the app keeps errors). */
  private droppedNotice(state: QueueState, errorsOn: boolean): WireEvent | null {
    const unsaid = state.dropped - state.reported;
    if (unsaid <= 0) return null;
    state.reported = state.dropped;
    if (!errorsOn) return null;
    return {
      id: uuidV7(),
      type: 'error',
      createdAt: new Date().toISOString(),
      launchId: this.ctx.clock.launchId,
      monotonicMs: this.ctx.clock.monotonicMs(),
      data: { kind: 'other', message: `${unsaid} events were dropped on this device: the queue was full or too old`, fingerprint: 'sdk.events_dropped', handled: true },
    };
  }

  /**
   * Sends the signed-in player's queue, batch by batch, until it is empty or a send fails (the frozen
   * batch then waits, unchanged, for the next flush).
   */
  async flush(options: { errorsOn: boolean; maxBatches?: number } = { errorsOn: true }): Promise<FlushResult> {
    await this.persist();
    const owner = this.ctx.subject();
    const result: FlushResult = { sent: 0, rejected: [], stoppedBy: null };
    if (!owner) return { ...result, stoppedBy: 'signed_out' };
    if (Date.now() < this.notBefore) return { ...result, stoppedBy: 'waiting' };
    let limit = BATCH_EVENTS;
    for (let round = 0; round < (options.maxBatches ?? 20); round += 1) {
      const batch = await withLock(this.lock(owner), async () => {
        const state = await this.load(owner);
        if (!state.batch) {
          const notice = this.droppedNotice(state, options.errorsOn);
          if (notice) state.pending.push(notice);
          state.batch = this.freeze(state, limit);
        }
        await this.save(owner, state);
        return state.batch;
      });
      if (!batch) return result;
      const outcome = await this.sendBatch(owner, batch, result);
      if (outcome === 'split') {
        limit = Math.max(1, Math.floor(batch.events.length / 2));
        continue;
      }
      if (outcome !== 'done') {
        result.stoppedBy = outcome;
        return result;
      }
      limit = BATCH_EVENTS;
    }
    return result;
  }

  private async sendBatch(owner: string, batch: FrozenBatch, result: FlushResult): Promise<'done' | 'split' | string> {
    const text = JSON.stringify({
      batchId: batch.batchId,
      platform: batch.platform,
      build: batch.build,
      sentAt: new Date().toISOString(),
      launchId: this.ctx.clock.launchId,
      monotonicMs: this.ctx.clock.monotonicMs(),
      events: batch.events,
    });
    const zipped = await gzip(text);
    const body = zipped ?? encoder.encode(text);
    if (body.length > 256 * 1024 && batch.events.length > 1) {
      await this.unfreeze(owner, batch);
      return 'split';
    }
    let answer;
    try {
      answer = await this.ctx.api.player('/v1/events', {
        method: 'POST',
        body: body as BodyInit,
        headers: { 'content-type': 'application/json', ...(zipped ? { 'content-encoding': 'gzip' } : {}) },
        owner,
      });
    } catch (err) {
      return this.failed(owner, batch, err);
    }
    this.backoffMs = 0;
    const json = answer.json ?? {};
    const retryIds = new Set(((json.retry as Array<{ id: string }>) ?? []).map((r) => r.id));
    const rejected = (json.rejected as Array<{ id: string; code: string }>) ?? [];
    await withLock(this.lock(owner), async () => {
      const state = await this.load(owner);
      if (state.batch?.batchId !== batch.batchId) return;
      state.pending.unshift(...batch.events.filter((e) => retryIds.has(e.id)));
      state.batch = null;
      await this.save(owner, state);
    });
    result.sent += batch.events.length - retryIds.size - rejected.length;
    result.rejected.push(...rejected.map((r) => ({ id: r.id, code: r.code })));
    if (retryIds.size) {
      // `retry` is for now (the app's events of the day, a build cap): wait before the next batch.
      this.notBefore = Date.now() + 60_000;
      return 'retry';
    }
    return 'done';
  }

  /** A batch never taken by the server goes back to the front of the queue (only before any answer said otherwise). */
  private async unfreeze(owner: string, batch: FrozenBatch): Promise<void> {
    await withLock(this.lock(owner), async () => {
      const state = await this.load(owner);
      if (state.batch?.batchId !== batch.batchId) return;
      state.pending.unshift(...batch.events);
      state.batch = null;
      await this.save(owner, state);
    });
  }

  private async failed(owner: string, batch: FrozenBatch, err: unknown): Promise<string> {
    if (!isKrtuworksError(err)) throw err;
    if (err.code === 'payload_too_large' && batch.events.length > 1) {
      await this.unfreeze(owner, batch);
      return 'split';
    }
    if (err.code === 'batch_id_reused') {
      // The id was spent on other events (a store restored from another device): same events, new id.
      await this.unfreeze(owner, batch);
      return 'done';
    }
    if (err.status === 400 || err.status === 413) {
      // The batch itself can never be taken: drop it rather than block every later event.
      await withLock(this.lock(owner), async () => {
        const state = await this.load(owner);
        if (state.batch?.batchId !== batch.batchId) return;
        state.dropped += batch.events.length;
        state.batch = null;
        await this.save(owner, state);
      });
      return err.code;
    }
    this.backoff(err);
    return err.code;
  }

  private backoff(err: KrtuworksError): void {
    this.backoffMs = Math.min(300_000, Math.max(5_000, this.backoffMs * 2));
    const wait = err.retryAfter !== null ? err.retryAfter * 1000 : this.backoffMs;
    this.notBefore = Date.now() + wait;
  }

  /** Lets the next flush try at once (back online, or the player changed). */
  resetBackoff(): void {
    this.notBefore = 0;
    this.backoffMs = 0;
  }
}
