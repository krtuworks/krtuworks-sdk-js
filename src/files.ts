import type { Api } from './api.js';
import type { ResolvedOptions } from './config.js';
import { KrtuworksError, isKrtuworksError } from './errors.js';
import { sha256Hex, uuidV4 } from './ids.js';
import { withLock } from './locks.js';
import type { KrtuStore } from './store.js';

export interface FileVersion {
  id: string;
  slot: string;
  device: string | null;
  generation: number;
  sizeBytes: number;
  sha256: string;
  platform: string | null;
  build: string | null;
  savedAt: string;
  fromMerge: boolean;
}

export interface SlotView {
  key: string;
  kind: 'SAVE' | 'PROFILE' | 'SETTINGS' | 'DEVICE_SETTINGS';
  name: string;
  retired: boolean;
  file: FileVersion | null;
  /** After a merge: the other account's version, waiting for the player's choice. */
  conflict: FileVersion | null;
  devices: FileVersion[];
}

export interface FileRead {
  bytes: Uint8Array;
  /** A save of this slot started on this device while the read ran: the read is older than what the player has here. */
  newerLocalSave: boolean;
  /** The version read (null when it is a similar device's file: a starting point, not this device's). */
  version: { id: string; generation: number; sha256: string; savedAt: string } | null;
  similarDevice: boolean;
}

/** An upload written to the store before it is sent, so a relaunch finishes it with the same id. */
interface PendingUpload {
  uploadId: string;
  owner: string;
  slot: string;
  device: string | null;
  base: string | null;
  /** Whether the save named a base (If-Match / If-None-Match: *); a resend sends exactly the same. */
  conditional: boolean;
  sha256: string;
  bytes: Uint8Array;
  deviceInfo: Record<string, string | number> | null;
  savedAt: number;
  /** Order of saves made in the same millisecond on this device. */
  seq?: number;
  /** 2: when it was last sent is in its own key (none = never sent). An older record was sent when it was made. */
  v?: 2;
}

export type ResumeOutcome = 'saved' | 'refused' | 'waiting' | 'replaced';

/**
 * How long after its last send an upload the server does not know can still arrive (an edge holds a
 * whole request before it reaches the server). Past it, a save no one heard of is gone.
 */
const ARRIVAL_WINDOW_MS = 15 * 60_000;

export interface SaveOptions {
  /** The version this one replaces (its id, the ETag of a read), or null for an empty slot. SETTINGS-like slots need neither. */
  base?: string | null;
  /** DEVICE_SETTINGS: this device's id and description (`os`, `gpu`, `ramMb`, `screenWidth`, `screenHeight`). */
  device?: string;
  deviceInfo?: Record<string, string | number>;
}

const POLL_LIMIT_MS = 60_000;
/** A settings slot takes one write this often; newer content replaces the one waiting for its turn. */
const SETTINGS_WRITE_MS = 30_000;
/** The wait before another try when the server answered `too_many_writes` without a Retry-After (its limit is 10 s per slot). */
const WRITE_RETRY_MS = 10_000;

/** A settings-like save held for its turn: only the newest of a lane waits, the older ones end with `save_replaced`. */
interface HeldWrite {
  upload: PendingUpload;
  resolve: (version: FileVersion) => void;
  reject: (err: unknown) => void;
}

interface LaneWrites {
  timer: ReturnType<typeof setTimeout> | null;
  held: HeldWrite | null;
  lastAt: number;
}

const replaced = (): KrtuworksError => new KrtuworksError('save_replaced', 'A newer save of this slot took the place of this one before it was sent.', 409);

/**
 * The player's files in the app's slots: a save is
 * written to the store first, sent with its upload id as the Idempotency-Key and asked about until it
 * is final; a conflict comes back with the slot's current version for the game's choice screen.
 */
export class Files {
  /** Per slot (and device), bumped by every save started here: a read compares it before and after. */
  private readonly revisions = new Map<string, number>();
  /** Orders the saves started in one millisecond. */
  private seq = 0;
  /** Per lane: when a settings write last went out and the one waiting for its turn. */
  private readonly writes = new Map<string, LaneWrites>();

  constructor(
    private readonly opts: ResolvedOptions,
    private readonly api: Api,
    private readonly store: KrtuStore,
    private readonly subject: () => string | null,
    private readonly generation: () => number,
    /** Told after every save the server activated (the client's link reminder counts the first one). */
    private readonly onSaved: () => void = () => undefined,
    /** How often a settings slot takes a write (a test sets it shorter). */
    private readonly settingsWriteMs: number = SETTINGS_WRITE_MS,
  ) {}

  private revisionKey(slot: string, device?: string | null): string {
    return `${slot}\u0000${device ?? ''}`;
  }

  private path(slot?: string): string {
    const base = `/v1/apps/${encodeURIComponent(this.opts.slug)}/files`;
    return slot === undefined ? base : `${base}/${encodeURIComponent(slot)}`;
  }

  private uploadKey(uploadId: string): string {
    return `krtu:${this.opts.clientId}:upload:${uploadId}`;
  }

  private sentKey(uploadId: string): string {
    return `krtu:${this.opts.clientId}:uploadSent:${uploadId}`;
  }

  /** One lane per player, slot and device: its saves go one at a time, oldest first. */
  private laneLock(upload: PendingUpload): string {
    return `krtu:${this.opts.clientId}:uploadLane:${JSON.stringify([upload.owner, upload.slot, upload.device ?? null])}`;
  }

  private async forget(uploadId: string): Promise<void> {
    await this.store.delete(this.uploadKey(uploadId));
    await this.store.delete(this.sentKey(uploadId));
  }

  /** When the upload was last sent; null when it never was. */
  private async sentAt(upload: PendingUpload): Promise<number | null> {
    const at = await this.store.get<number>(this.sentKey(upload.uploadId));
    if (typeof at === 'number') return at;
    return upload.v === 2 ? null : upload.savedAt;
  }

  private static before(a: PendingUpload, b: PendingUpload): boolean {
    if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt;
    if ((a.seq ?? 0) !== (b.seq ?? 0)) return (a.seq ?? 0) < (b.seq ?? 0);
    return a.uploadId < b.uploadId;
  }

  /** The store's uploads of `upload`'s lane, oldest first. */
  private async lane(upload: PendingUpload): Promise<PendingUpload[]> {
    const out: PendingUpload[] = [];
    for (const key of await this.store.keys(`krtu:${this.opts.clientId}:upload:`)) {
      const u = await this.store.get<PendingUpload>(key);
      if (u && u.owner === upload.owner && u.slot === upload.slot && (u.device ?? null) === (upload.device ?? null)) out.push(u);
    }
    return out.sort((a, b) => (Files.before(a, b) ? -1 : Files.before(b, a) ? 1 : 0));
  }

  async list(): Promise<{ slots: SlotView[]; limits: Record<string, number> }> {
    return this.listFor(undefined);
  }

  private async listFor(owner: string | undefined): Promise<{ slots: SlotView[]; limits: Record<string, number> }> {
    const answer = await this.api.player(this.path(), { owner });
    return answer.json as unknown as { slots: SlotView[]; limits: Record<string, number> };
  }

  /** A slot's current version; null when `ifNoneMatch` (a version id held) is still current. */
  async read(slot: string, options: { device?: string; deviceInfo?: Record<string, string | number>; ifNoneMatch?: string } = {}): Promise<FileRead | null> {
    const revisionKey = this.revisionKey(slot, options.device);
    const revision = this.revisions.get(revisionKey) ?? 0;
    const answer = await this.api.player(this.path(slot), {
      query: { device: options.device, platform: this.opts.platform, ...options.deviceInfo },
      headers: options.ifNoneMatch ? { 'if-none-match': options.ifNoneMatch } : {},
      bytes: true,
      accept: [304],
    });
    if (answer.status === 304) return null;
    const etag = answer.headers.get('etag');
    const similar = answer.headers.get('x-krtu-similar-device') === 'true';
    return {
      bytes: answer.bytes ?? new Uint8Array(),
      newerLocalSave: (this.revisions.get(revisionKey) ?? 0) !== revision,
      similarDevice: similar,
      version: etag
        ? {
            id: etag.replace(/^W\//, '').replace(/"/g, ''),
            generation: Number(answer.headers.get('x-krtu-generation') ?? 0),
            sha256: answer.headers.get('x-krtu-sha256') ?? '',
            savedAt: answer.headers.get('x-krtu-saved-at') ?? '',
          }
        : null,
    };
  }

  /**
   * Saves a new version of `slot`. Resolves with the new version once the server activated it; rejects
   * with `file_conflict` (`details.current`: the version now in the slot) when another one came first,
   * and with `save_replaced` when a newer save of the slot took its place before it was sent.
   */
  async save(slot: string, data: Uint8Array, options: SaveOptions = {}): Promise<FileVersion> {
    const owner = this.subject();
    if (!owner) throw new KrtuworksError('signed_out', 'No player is signed in.');
    const revisionKey = this.revisionKey(slot, options.device);
    this.revisions.set(revisionKey, (this.revisions.get(revisionKey) ?? 0) + 1);
    const upload: PendingUpload = {
      uploadId: uuidV4(),
      owner,
      slot,
      device: options.device ?? null,
      base: options.base ?? null,
      conditional: options.base !== undefined,
      sha256: await sha256Hex(data),
      bytes: data,
      deviceInfo: options.deviceInfo ?? null,
      savedAt: Date.now(),
      seq: (this.seq += 1),
      v: 2,
    };
    await this.store.set(this.uploadKey(upload.uploadId), upload);
    if (!upload.conditional) return this.paced(upload);
    return this.writeNow(upload);
  }

  /** Sends a save at once; a `too_many_writes` answer is tried again after its Retry-After. */
  private async writeNow(upload: PendingUpload): Promise<FileVersion> {
    try {
      return await this.pump(upload, () => undefined);
    } catch (err) {
      if (isKrtuworksError(err, 'too_many_writes')) this.retryLater(upload, err.retryAfter, null);
      throw err;
    }
  }

  /**
   * Tries `upload` again after a `too_many_writes` answer (the save stays on the device meanwhile). `held`
   * is the caller still waiting for it, who hears how it ended.
   */
  private retryLater(upload: PendingUpload, retryAfter: number | null, held: HeldWrite | null): void {
    const timer = setTimeout(
      () => {
        this.pump(upload, () => undefined).then(
          (version) => held?.resolve(version),
          (err: unknown) => {
            if (isKrtuworksError(err, 'too_many_writes')) this.retryLater(upload, err.retryAfter, held);
            else held?.reject(err);
          },
        );
      },
      Math.max(1000, (retryAfter ?? WRITE_RETRY_MS / 1000) * 1000),
    );
    (timer as { unref?: () => void }).unref?.();
  }

  /**
   * A settings-like save (no base: SETTINGS, DEVICE_SETTINGS) goes out at most once every
   * `SETTINGS_WRITE_MS` per lane, the newest content winning; it is on the device from the moment it is made.
   * `flushWrites` sends what waits at once.
   */
  private paced(upload: PendingUpload): Promise<FileVersion> {
    const lane = this.laneLock(upload);
    const writes = this.writes.get(lane) ?? { timer: null, held: null, lastAt: 0 };
    this.writes.set(lane, writes);
    return new Promise<FileVersion>((resolve, reject) => {
      const older = writes.held;
      writes.held = { upload, resolve, reject };
      if (older) void this.forget(older.upload.uploadId).then(() => older.reject(replaced()));
      const wait = writes.lastAt + this.settingsWriteMs - Date.now();
      if (wait <= 0) void this.release(lane);
      else if (!writes.timer) {
        writes.timer = setTimeout(() => void this.release(lane), wait);
        (writes.timer as { unref?: () => void }).unref?.();
      }
    });
  }

  private async release(lane: string): Promise<void> {
    const writes = this.writes.get(lane);
    const held = writes?.held;
    if (!writes || !held) return;
    if (writes.timer) clearTimeout(writes.timer);
    writes.timer = null;
    writes.held = null;
    writes.lastAt = Date.now();
    try {
      held.resolve(await this.pump(held.upload, () => undefined));
    } catch (err) {
      if (isKrtuworksError(err, 'too_many_writes')) this.retryLater(held.upload, err.retryAfter, held);
      else held.reject(err);
    }
  }

  /** Sends the settings saves waiting for their turn now (the app pauses or ends). */
  async flushWrites(): Promise<void> {
    await Promise.all([...this.writes.keys()].map((lane) => this.release(lane)));
  }

  /**
   * Sends `target` in its lane's order. An earlier save of the lane that was never sent is replaced by the
   * newer one; an earlier save that was sent is settled first (asked how it ended, or sent again with its
   * id), so an older copy never lands after a newer one. `target` itself is replaced when a newer save of
   * the lane waits behind it, unsent. `tell` hears what became of the earlier ones.
   */
  private async pump(target: PendingUpload, tell: (upload: PendingUpload, outcome: ResumeOutcome, code?: string) => void): Promise<FileVersion> {
    return withLock(this.laneLock(target), async () => {
      const lane = await this.lane(target);
      const at = lane.findIndex((u) => u.uploadId === target.uploadId);
      if (at < 0) return this.settledElsewhere(target);
      // The earlier ones never sent go first: this save replaces them whatever became of the others.
      const sentEarlier: PendingUpload[] = [];
      for (const earlier of lane.slice(0, at)) {
        if ((await this.sentAt(earlier)) !== null) sentEarlier.push(earlier);
        else {
          await this.forget(earlier.uploadId);
          tell(earlier, 'replaced');
        }
      }
      for (const earlier of sentEarlier) {
        const ended = await this.settleEarlier(earlier);
        tell(earlier, ended.outcome, ended.code);
      }
      if (at < lane.length - 1 && (await this.sentAt(target)) === null) {
        await this.forget(target.uploadId);
        throw replaced();
      }
      return this.send(target);
    });
  }

  /**
   * An earlier save of a lane that was sent and whose outcome is not known here: how it ended, before
   * anything newer goes. Throws when it has not ended yet (or the server cannot be asked): the lane waits.
   */
  private async settleEarlier(upload: PendingUpload): Promise<{ outcome: ResumeOutcome; code?: string }> {
    let state: Record<string, unknown> | null;
    try {
      state = (await this.api.player(`${this.path(upload.slot)}/uploads/${upload.uploadId}`, { owner: upload.owner })).json;
    } catch (err) {
      if (!isKrtuworksError(err, 'upload_not_found')) throw err;
      // The server never had it. A save with a version check is replaced at once: should it still arrive,
      // the newer save holds the slot and the check refuses it. One without a check could land over the
      // newer save, so it is replaced only once it can no longer arrive.
      if (upload.conditional || Date.now() - ((await this.sentAt(upload)) ?? 0) >= ARRIVAL_WINDOW_MS) {
        await this.forget(upload.uploadId);
        return { outcome: 'replaced' };
      }
      // It may still be on its way: sent again with its id, the server takes both as one upload.
      try {
        await this.send(upload);
        return { outcome: 'saved' };
      } catch (sent) {
        if (isKrtuworksError(sent) && !sent.keepsQueued && sent.code !== 'upload_pending') return { outcome: 'refused', code: sent.code };
        throw sent;
      }
    }
    if (state?.status === 'ACTIVATED') {
      await this.forget(upload.uploadId);
      this.onSaved();
      return { outcome: 'saved' };
    }
    if (state?.status === 'REJECTED') {
      await this.forget(upload.uploadId);
      return { outcome: 'refused', code: String(state.code ?? 'write_failed') };
    }
    throw new KrtuworksError('upload_pending', 'An earlier save of this slot is still being written; this one goes after it.', 202, null, { uploadId: upload.uploadId });
  }

  /** The save's record is gone: another tab or a resume finished or replaced it; the server says how it ended. */
  private async settledElsewhere(upload: PendingUpload): Promise<FileVersion> {
    let state: Record<string, unknown> | null;
    try {
      state = (await this.api.player(`${this.path(upload.slot)}/uploads/${upload.uploadId}`, { owner: upload.owner })).json;
    } catch (err) {
      if (isKrtuworksError(err, 'upload_not_found')) throw replaced();
      throw err;
    }
    return this.settle(upload, state);
  }

  private async send(upload: PendingUpload): Promise<FileVersion> {
    const headers: Record<string, string> = { 'idempotency-key': upload.uploadId, 'content-type': 'application/octet-stream' };
    if (upload.conditional) {
      if (upload.base) headers['if-match'] = upload.base;
      else headers['if-none-match'] = '*';
    }
    await this.store.set(this.sentKey(upload.uploadId), Date.now());
    let answer;
    try {
      answer = await this.api.player(this.path(upload.slot), {
        method: 'PUT',
        query: { platform: this.opts.platform, build: this.opts.build, device: upload.device ?? undefined, ...(upload.deviceInfo ?? {}) },
        headers,
        body: upload.bytes as BodyInit,
        accept: [202],
        owner: upload.owner,
      });
    } catch (err) {
      // Only a refusal of the save itself (or a gone account) lets it go; a retry, a waiting refusal
      // (a merge, a ban, a switch) or a credentials failure keeps it on the device.
      if (isKrtuworksError(err) && !err.keepsQueued) await this.forget(upload.uploadId);
      throw err;
    }
    if (answer.status === 201) return this.done(upload, (answer.json?.file as FileVersion) ?? null);
    return this.settle(upload, answer.json);
  }

  /** Reads an upload's state (200 again or 202) until it is final. */
  private async settle(upload: PendingUpload, state: Record<string, unknown> | null): Promise<FileVersion> {
    const started = Date.now();
    const generation = this.generation();
    let wait = 1000;
    let current = state;
    for (;;) {
      const status = current?.status;
      if (status === 'ACTIVATED') return this.done(upload, null, current?.file as { id: string } | null);
      if (status === 'REJECTED') {
        await this.forget(upload.uploadId);
        const code = String(current?.code ?? 'write_failed');
        const details: Record<string, unknown> = { upload: current };
        // The chooser needs the version now in the slot, which the upload's record does not carry.
        if (code === 'file_conflict') details.current = await this.currentOf(upload).catch(() => undefined);
        throw new KrtuworksError(code, 'The save was refused.', 409, null, details);
      }
      if (Date.now() - started > POLL_LIMIT_MS) {
        throw new KrtuworksError('upload_pending', 'The save is still being written; it is finished on a later launch.', 202, null, { uploadId: upload.uploadId });
      }
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(8000, wait * 2);
      // Another player now: this upload is asked about with its own player's token on a later sign-in.
      if (this.generation() !== generation) throw new KrtuworksError('context_changed', 'The player changed while the save was being written; it is finished when that player signs in again.');
      const answer = await this.api.player(`${this.path(upload.slot)}/uploads/${upload.uploadId}`, { owner: upload.owner });
      current = answer.json;
    }
  }

  /** The version now in `upload`'s slot (for its device in a DEVICE_SETTINGS slot), or undefined. */
  private async currentOf(upload: PendingUpload): Promise<FileVersion | undefined> {
    const slot = (await this.listFor(upload.owner)).slots.find((s) => s.key === upload.slot);
    if (upload.device) return slot?.devices.find((v) => v.device === upload.device) ?? undefined;
    return slot?.file ?? undefined;
  }

  private async done(upload: PendingUpload, file: FileVersion | null, ref?: { id: string } | null): Promise<FileVersion> {
    await this.forget(upload.uploadId);
    this.onSaved();
    if (file) return file;
    // An answer replayed from the upload's record names the version; read the slot for the whole of it.
    const list = await this.listFor(upload.owner);
    const slot = list.slots.find((s) => s.key === upload.slot);
    const versions = [slot?.file, ...(slot?.devices ?? [])].filter((v): v is FileVersion => !!v);
    const found = versions.find((v) => v.id === ref?.id) ?? versions[0];
    if (!found) throw new KrtuworksError('file_not_found', 'The saved version is no longer the slot\'s.', 404);
    return found;
  }

  /**
   * Saves left unfinished by an earlier launch (an answer lost, a 202, made offline): finishes the
   * signed-in player's, the newest of each slot (and device) last; an older one never sent is replaced.
   */
  async resume(): Promise<Array<{ uploadId: string; slot: string; outcome: ResumeOutcome; code?: string }>> {
    const owner = this.subject();
    const out: Array<{ uploadId: string; slot: string; outcome: ResumeOutcome; code?: string }> = [];
    if (!owner) return out;
    const uploads = `krtu:${this.opts.clientId}:upload:`;
    const sent = `krtu:${this.opts.clientId}:uploadSent:`;
    const ids = new Set((await this.store.keys(uploads)).map((k) => k.slice(uploads.length)));
    for (const key of await this.store.keys(sent)) if (!ids.has(key.slice(sent.length))) await this.store.delete(key);
    const newest = new Map<string, PendingUpload>();
    for (const id of ids) {
      const upload = await this.store.get<PendingUpload>(this.uploadKey(id));
      if (!upload || upload.owner !== owner) continue;
      const lane = this.laneLock(upload);
      const held = newest.get(lane);
      if (!held || Files.before(held, upload)) newest.set(lane, upload);
    }
    const tell = (u: PendingUpload, outcome: ResumeOutcome, code?: string): void => {
      out.push({ uploadId: u.uploadId, slot: u.slot, outcome, ...(code ? { code } : {}) });
    };
    for (const upload of newest.values()) {
      try {
        // Sent again with the same id and bytes: the server answers what the first one did.
        await this.pump(upload, tell);
        tell(upload, 'saved');
      } catch (err) {
        const code = isKrtuworksError(err) ? err.code : 'error';
        tell(upload, code === 'save_replaced' ? 'replaced' : code === 'upload_pending' || (isKrtuworksError(err) && err.keepsQueued) ? 'waiting' : 'refused', code);
      }
    }
    return out;
  }

  /** Saves of another player waiting on this device (a merged account's): the game asks the player what to keep. */
  async waitingFor(owner: string): Promise<Array<{ uploadId: string; slot: string; savedAt: number }>> {
    const out: Array<{ uploadId: string; slot: string; savedAt: number }> = [];
    for (const key of await this.store.keys(`krtu:${this.opts.clientId}:upload:`)) {
      const upload = await this.store.get<PendingUpload>(key);
      if (upload?.owner === owner) out.push({ uploadId: upload.uploadId, slot: upload.slot, savedAt: upload.savedAt });
    }
    return out;
  }

  /**
   * A save another player left waiting (a merged account's) that the player chose to keep:
   * saved now as this player's, over `base` (the slot's version the player saw), with a new upload id.
   */
  async adoptWaiting(uploadId: string, base: string | null): Promise<FileVersion> {
    const waiting = await this.store.get<PendingUpload>(this.uploadKey(uploadId));
    if (!waiting) throw new KrtuworksError('upload_not_found', 'No such waiting save on this device.', 404);
    const saved = await this.save(waiting.slot, waiting.bytes, { base, device: waiting.device ?? undefined, deviceInfo: waiting.deviceInfo ?? undefined });
    await this.forget(uploadId);
    return saved;
  }

  /** The account of `owner` is gone: the saves waiting for it are dropped. */
  async drop(owner: string): Promise<void> {
    for (const key of await this.store.keys(`krtu:${this.opts.clientId}:upload:`)) {
      const upload = await this.store.get<PendingUpload>(key);
      if (upload?.owner !== owner) continue;
      await this.forget(upload.uploadId);
      const writes = this.writes.get(this.laneLock(upload));
      if (writes?.held?.upload.uploadId === upload.uploadId) {
        writes.held.reject(new KrtuworksError('account_deleted', 'The account was deleted; the save was dropped.', 401));
        writes.held = null;
      }
    }
  }

  /** A waiting save the player chose not to keep. */
  async discardWaiting(uploadId: string): Promise<void> {
    await this.forget(uploadId);
  }

  /** After a merge: keep `keep` (the slot's version or the merged one) over `current` (the one the player saw). */
  async resolve(slot: string, keep: string, current: string): Promise<FileVersion> {
    const answer = await this.api.player(`${this.path(slot)}/resolve`, { method: 'POST', json: { keep, current } });
    return answer.json?.file as FileVersion;
  }
}
