import type { Api } from './api.js';
import type { ResolvedOptions } from './config.js';
import { KrtuworksError, isKrtuworksError } from './errors.js';
import { sha256Hex, uuidV4 } from './ids.js';
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
}

export interface SaveOptions {
  /** The version this one replaces (its id, the ETag of a read), or null for an empty slot. SETTINGS-like slots need neither. */
  base?: string | null;
  /** DEVICE_SETTINGS: this device's id and description (`os`, `gpu`, `ramMb`, `screenWidth`, `screenHeight`). */
  device?: string;
  deviceInfo?: Record<string, string | number>;
}

const POLL_LIMIT_MS = 60_000;

/**
 * The player's files in the app's slots: a save is
 * written to the store first, sent with its upload id as the Idempotency-Key and asked about until it
 * is final; a conflict comes back with the slot's current version for the game's choice screen.
 */
export class Files {
  /** Per slot (and device), bumped by every save started here: a read compares it before and after. */
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly opts: ResolvedOptions,
    private readonly api: Api,
    private readonly store: KrtuStore,
    private readonly subject: () => string | null,
    private readonly generation: () => number,
    /** Told after every save the server activated (the client's link reminder counts the first one). */
    private readonly onSaved: () => void = () => undefined,
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

  async list(): Promise<{ slots: SlotView[]; limits: Record<string, number> }> {
    const answer = await this.api.player(this.path());
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
   * with `file_conflict` (`details.current`: the version now in the slot) when another one came first.
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
    };
    await this.store.set(this.uploadKey(upload.uploadId), upload);
    return this.send(upload);
  }

  private async send(upload: PendingUpload): Promise<FileVersion> {
    const headers: Record<string, string> = { 'idempotency-key': upload.uploadId, 'content-type': 'application/octet-stream' };
    if (upload.conditional) {
      if (upload.base) headers['if-match'] = upload.base;
      else headers['if-none-match'] = '*';
    }
    let answer;
    try {
      answer = await this.api.player(this.path(upload.slot), {
        method: 'PUT',
        query: { platform: this.opts.platform, build: this.opts.build, device: upload.device ?? undefined, ...(upload.deviceInfo ?? {}) },
        headers,
        body: upload.bytes as BodyInit,
        accept: [202],
      });
    } catch (err) {
      if (isKrtuworksError(err) && !err.retryable) await this.store.delete(this.uploadKey(upload.uploadId));
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
        await this.store.delete(this.uploadKey(upload.uploadId));
        throw new KrtuworksError(String(current?.code ?? 'write_failed'), 'The save was refused.', 409, null, { upload: current });
      }
      if (Date.now() - started > POLL_LIMIT_MS) {
        throw new KrtuworksError('upload_pending', 'The save is still being written; it is finished on a later launch.', 202, null, { uploadId: upload.uploadId });
      }
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(8000, wait * 2);
      // Another player now: this upload is asked about with its own player's token on a later sign-in.
      if (this.generation() !== generation) throw new KrtuworksError('context_changed', 'The player changed while the save was being written; it is finished when that player signs in again.');
      const answer = await this.api.player(`${this.path(upload.slot)}/uploads/${upload.uploadId}`);
      current = answer.json;
    }
  }

  private async done(upload: PendingUpload, file: FileVersion | null, ref?: { id: string } | null): Promise<FileVersion> {
    await this.store.delete(this.uploadKey(upload.uploadId));
    this.onSaved();
    if (file) return file;
    // An answer replayed from the upload's record names the version; read the slot for the whole of it.
    const list = await this.list();
    const slot = list.slots.find((s) => s.key === upload.slot);
    const versions = [slot?.file, ...(slot?.devices ?? [])].filter((v): v is FileVersion => !!v);
    const found = versions.find((v) => v.id === ref?.id) ?? versions[0];
    if (!found) throw new KrtuworksError('file_not_found', 'The saved version is no longer the slot\'s.', 404);
    return found;
  }

  /** Saves left unfinished by an earlier launch (an answer lost, a 202): finishes the signed-in player's. */
  async resume(): Promise<Array<{ uploadId: string; slot: string; outcome: 'saved' | 'refused' | 'waiting'; code?: string }>> {
    const owner = this.subject();
    const out: Array<{ uploadId: string; slot: string; outcome: 'saved' | 'refused' | 'waiting'; code?: string }> = [];
    if (!owner) return out;
    for (const key of await this.store.keys(`krtu:${this.opts.clientId}:upload:`)) {
      const upload = await this.store.get<PendingUpload>(key);
      if (!upload || upload.owner !== owner) continue;
      try {
        // Sent again with the same id and bytes: the server answers what the first one did.
        await this.send(upload);
        out.push({ uploadId: upload.uploadId, slot: upload.slot, outcome: 'saved' });
      } catch (err) {
        const code = isKrtuworksError(err) ? err.code : 'error';
        out.push({ uploadId: upload.uploadId, slot: upload.slot, outcome: code === 'upload_pending' || (isKrtuworksError(err) && err.retryable) ? 'waiting' : 'refused', code });
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
    await this.store.delete(this.uploadKey(uploadId));
    return saved;
  }

  /** A waiting save the player chose not to keep. */
  async discardWaiting(uploadId: string): Promise<void> {
    await this.store.delete(this.uploadKey(uploadId));
  }

  /** After a merge: keep `keep` (the slot's version or the merged one) over `current` (the one the player saw). */
  async resolve(slot: string, keep: string, current: string): Promise<FileVersion> {
    const answer = await this.api.player(`${this.path(slot)}/resolve`, { method: 'POST', json: { keep, current } });
    return answer.json?.file as FileVersion;
  }
}
