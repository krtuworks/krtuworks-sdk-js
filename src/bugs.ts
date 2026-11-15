import type { Api } from './api.js';
import type { ResolvedOptions } from './config.js';
import { KrtuworksError, isKrtuworksError } from './errors.js';
import type { EventPosition, WireEvent } from './events.js';
import { uuidV4 } from './ids.js';
import type { KrtuStore } from './store.js';

/** The fixed categories: the same menu in every app. */
export const BUG_CATEGORIES = ['CRASH', 'GAMEPLAY', 'GRAPHICS', 'AUDIO', 'PERFORMANCE', 'CONTROLS', 'TEXT', 'OTHER'] as const;
export type BugCategory = (typeof BUG_CATEGORIES)[number];

export interface BugReportInput {
  category: BugCategory;
  /** What the player wrote, 1-4000 characters. */
  description: string;
  /** A picture of the screen (PNG, JPEG or WebP, at most 5 MB); the player may leave it out. */
  screenshot?: Uint8Array | ArrayBuffer | Blob;
  /** Where the player is; the level in play when not given. */
  level?: string;
  position?: EventPosition;
  /** The frame rate now; the last one the performance family told when not given. */
  fps?: number;
}

/** A report as its player sees it: never the notes, the assignee or the labels. */
export interface BugReportView {
  id: string;
  category: BugCategory;
  description: string | null;
  platform: string;
  build: string;
  createdAt: string;
  screenshot: boolean;
  /** NEW, INVESTIGATING, RESOLVED, CANNOT_REPRODUCE or DUPLICATE; a duplicate shows its original's. */
  status: string;
  fixedIn: string | null;
  fixedAt: string | null;
  duplicate: boolean;
}

export interface BugFlushResult {
  sent: number;
  /** Reports or screenshots the server refused for good; they are not sent again. */
  dropped: Array<{ reportId: string; code: string; screenshotOnly: boolean }>;
  stoppedBy?: string;
}

interface Waiting {
  reportId: string;
  madeAt: number;
  /** The report as it goes to the server, frozen when made: the same reportId always carries the same body. */
  body: Record<string, unknown>;
  screenshot: { bytes: Uint8Array; type: string } | null;
  /** The server's id once the report is in (the screenshot follows it). */
  bugId: string | null;
}

interface FixedState {
  told: string[];
}

const MAX_DESCRIPTION = 4000;
const MAX_SCREENSHOT = 5 * 1024 * 1024;
const MAX_WAITING = 20;
const RING_EVENTS = 50;
const EVENT_CHARS = 1800;
/** The server takes at most 100 KB of events; the SDK's own part stays under it so it never costs the player's report. */
const EVENTS_CHARS = 90_000;
const LOG_CHARS = 32_768;
const LOG_LINE = 1000;
const RETRY_MS = 60_000;
/** The report can never be taken as it is: dropped rather than sent forever. */
const REPORT_REFUSED = new Set([400, 413]);
const REPORT_REFUSED_CODES = new Set(['report_id_reused']);
/** The screenshot can never be taken (too late, too big, not a picture, the report gone); `screenshot_exists` is done. */
const SCREENSHOT_REFUSED = new Set([400, 404, 409, 411, 413, 415]);
const TOLD_KEPT = 200;

/** The picture's type from its first bytes (what the server takes). */
export function screenshotType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function refused(message: string): KrtuworksError {
  return new KrtuworksError('invalid_request', message, 400);
}

/**
 * The body the server takes for a report: the player's words and what the SDK knows of the moment (the
 * platform, build, device, language, level, place, frame rate, the last events and log lines).
 * Checked here so a report that can never be taken is refused at once instead of waiting in the queue.
 */
export function reportBody(
  input: BugReportInput,
  context: { reportId: string; opts: ResolvedOptions; level: string | null; fps: number | null; events: Record<string, unknown>[]; log: string },
): Record<string, unknown> {
  if (!(BUG_CATEGORIES as readonly string[]).includes(input.category)) throw refused(`category is one of ${BUG_CATEGORIES.join(', ')}`);
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!description || description.length > MAX_DESCRIPTION) throw refused(`description is what the player wrote, 1-${MAX_DESCRIPTION} characters`);
  // The level the SDK saw is cut to fit; one the game names must fit.
  const level = input.level ?? (context.level ? context.level.slice(0, 200) : null);
  if (level !== null && (typeof level !== 'string' || !level.trim() || level.length > 200)) throw refused('level is 1-200 characters');
  const fps = input.fps ?? context.fps;
  if (fps !== null && (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 0 || fps > 1000)) throw refused('fps is a number from 0 to 1000');
  const position = input.position;
  if (position && (typeof position.area !== 'string' || !position.area || position.area.length > 100 || !Number.isFinite(position.x) || !Number.isFinite(position.y))) {
    throw refused('position is {area, x, y, z?}');
  }
  let events = context.events;
  while (events.length && JSON.stringify(events).length > EVENTS_CHARS) events = events.slice(1);
  const device = context.opts.device ? Object.fromEntries(Object.entries(context.opts.device).filter(([, v]) => v !== undefined && v !== null)) : null;
  return {
    reportId: context.reportId,
    category: input.category,
    description,
    platform: context.opts.platform,
    build: context.opts.build,
    ...(device && Object.keys(device).length ? { device } : {}),
    ...(context.opts.locale ? { locale: context.opts.locale } : {}),
    ...(level ? { level: level.trim() } : {}),
    ...(position ? { position: { area: position.area, x: position.x, y: position.y, ...(position.z !== undefined ? { z: position.z } : {}) } } : {}),
    ...(fps !== null ? { fps: Math.round(fps * 10) / 10 } : {}),
    ...(events.length ? { events } : {}),
    ...(context.log ? { log: context.log } : {}),
  };
}

/**
 * The reports a player told about since the last check: the first check of a player on this device
 * tells nothing (it only learns what was already fixed); a report made here starts the record empty,
 * so its fix is told even when another device saw it first.
 */
export function newlyFixed(reports: BugReportView[], state: FixedState | undefined): { fixed: BugReportView[]; state: FixedState } {
  const fixedIds = reports.filter((r) => r.status === 'RESOLVED').map((r) => r.id);
  if (!state) return { fixed: [], state: { told: fixedIds.slice(0, TOLD_KEPT) } };
  const told = new Set(state.told);
  const fixed = reports.filter((r) => r.status === 'RESOLVED' && !told.has(r.id));
  return { fixed, state: { told: [...new Set([...fixedIds, ...state.told])].slice(0, TOLD_KEPT) } };
}

/**
 * Bug reports from inside the app: a report is kept on the device first and
 * sent when it can be (offline, before the player exists, after a merge), its screenshot right after
 * it. The server takes a reportId once; the body is frozen when the report is made, so sending it again
 * after a lost answer gets the same report. The last events and log lines are kept in memory only.
 */
export class BugReports {
  private readonly events: Record<string, unknown>[] = [];
  private logLines: string[] = [];
  private logChars = 0;
  private lastFps: number | null = null;
  /** Reports that wait before their next try (in memory: a new launch tries them all again). */
  private readonly waitUntil = new Map<string, number>();
  private readonly fixedListeners = new Set<(report: BugReportView) => void>();

  constructor(
    private readonly opts: ResolvedOptions,
    private readonly store: KrtuStore,
    private readonly api: Api,
    private readonly owner: () => string,
    private readonly subject: () => string | null,
  ) {}

  private prefix(owner: string): string {
    return `krtu:${this.opts.clientId}:bugs:${owner}:`;
  }

  private fixedKey(subject: string): string {
    return `krtu:${this.opts.clientId}:bugsFixed:${subject}`;
  }

  /** An event the SDK kept, for the next report's "last events". */
  noteEvent(event: WireEvent): void {
    const entry: Record<string, unknown> = { type: event.type, at: event.createdAt, ...(event.position ? { position: event.position } : {}) };
    if (event.data && JSON.stringify(event.data).length <= EVENT_CHARS) entry.data = event.data;
    this.events.push(entry);
    if (this.events.length > RING_EVENTS) this.events.shift();
    const fps = event.type === 'performance' ? event.data?.fps : undefined;
    if (typeof fps === 'number' && Number.isFinite(fps)) this.lastFps = fps;
  }

  /** A line for the next report's log (the app's own, and the errors the SDK told). */
  log(message: string): void {
    const line = `${new Date().toISOString()} ${String(message).slice(0, LOG_LINE)}`;
    this.logLines.push(line);
    this.logChars += line.length + 1;
    while (this.logChars > LOG_CHARS && this.logLines.length) this.logChars -= this.logLines.shift()!.length + 1;
  }

  async report(input: BugReportInput, level: string | null): Promise<{ reportId: string }> {
    const owner = this.owner();
    if ((await this.store.keys(this.prefix(owner))).length >= MAX_WAITING) {
      throw new KrtuworksError('too_many_reports', `At most ${MAX_WAITING} bug reports wait on this device; they are sent when the app is online.`, 429);
    }
    let screenshot: Waiting['screenshot'] = null;
    if (input.screenshot !== undefined) {
      const raw = input.screenshot instanceof Uint8Array ? input.screenshot : new Uint8Array(input.screenshot instanceof ArrayBuffer ? input.screenshot : await input.screenshot.arrayBuffer());
      const type = screenshotType(raw);
      if (!type) throw refused('The screenshot is a PNG, JPEG or WebP picture');
      if (raw.length > MAX_SCREENSHOT) throw refused('The screenshot is at most 5 MB');
      screenshot = { bytes: raw.slice(), type };
    }
    const reportId = uuidV4();
    const body = reportBody(input, { reportId, opts: this.opts, level, fps: this.lastFps, events: [...this.events], log: this.logLines.join('\n') });
    const waiting: Waiting = { reportId, madeAt: Date.now(), body, screenshot, bugId: null };
    await this.store.set(`${this.prefix(owner)}${reportId}`, waiting);
    const subject = this.subject();
    if (subject && !(await this.store.get(this.fixedKey(subject)))) await this.store.set(this.fixedKey(subject), { told: [] } satisfies FixedState);
    return { reportId };
  }

  /** Reports (with their screenshots) that wait on this device for the player, or for the first player. */
  async waiting(): Promise<number> {
    return (await this.store.keys(this.prefix(this.owner()))).length;
  }

  /** Hands one owner's waiting reports to another (the anonymous queue to the first player, a confirmed merge). */
  async move(from: string, to: string): Promise<void> {
    if (from === to) return;
    for (const key of await this.store.keys(this.prefix(from))) {
      const w = await this.store.get<Waiting>(key);
      if (w) await this.store.set(`${this.prefix(to)}${w.reportId}`, w);
      await this.store.delete(key);
    }
  }

  async flush(now = Date.now()): Promise<BugFlushResult> {
    const result: BugFlushResult = { sent: 0, dropped: [] };
    const subject = this.subject();
    if (!subject) return result;
    const keys = await this.store.keys(this.prefix(subject));
    const queue = (await Promise.all(keys.map(async (k) => ({ key: k, w: await this.store.get<Waiting>(k) }))))
      .filter((e): e is { key: string; w: Waiting } => !!e.w)
      .sort((a, b) => a.w.madeAt - b.w.madeAt);
    for (const { key, w } of queue) {
      if ((this.waitUntil.get(w.reportId) ?? 0) > now) continue;
      try {
        if (!w.bugId) {
          const answer = await this.api.player('/v1/me/bug-reports', { method: 'POST', json: w.body });
          const bugId = (answer.json?.report as { id?: unknown } | undefined)?.id;
          if (typeof bugId !== 'string') throw new KrtuworksError('invalid_answer', 'The server answered without the report.');
          w.bugId = bugId;
          if (w.screenshot) await this.store.set(key, w);
        }
        if (w.screenshot) {
          try {
            await this.api.player(`/v1/me/bug-reports/${encodeURIComponent(w.bugId)}/screenshot`, {
              method: 'PUT',
              body: w.screenshot.bytes as BodyInit,
              headers: { 'content-type': w.screenshot.type },
            });
          } catch (err) {
            // The report is in: a screenshot it already has is done, one refused for good is let go.
            if (!isKrtuworksError(err) || !SCREENSHOT_REFUSED.has(err.status)) throw err;
            if (err.code !== 'screenshot_exists') result.dropped.push({ reportId: w.reportId, code: err.code, screenshotOnly: true });
          }
        }
        await this.store.delete(key);
        this.waitUntil.delete(w.reportId);
        result.sent += 1;
      } catch (err) {
        const e = isKrtuworksError(err) ? err : new KrtuworksError('network_error', String(err));
        if (!w.bugId && (REPORT_REFUSED.has(e.status) || REPORT_REFUSED_CODES.has(e.code))) {
          await this.store.delete(key);
          result.dropped.push({ reportId: w.reportId, code: e.code, screenshotOnly: false });
          continue;
        }
        // Anything else (no answer, a busy or closed server, a player in a merge, a ban, the module
        // off for now) keeps the report for later.
        if (e.code !== 'context_changed') this.waitUntil.set(w.reportId, now + (e.retryAfter !== null ? e.retryAfter * 1000 : RETRY_MS));
        return { ...result, stoppedBy: e.code };
      }
    }
    return result;
  }

  /** The player's reports in this app and environment, newest first; fixes not told yet are told. */
  async mine(): Promise<BugReportView[]> {
    const subject = this.subject();
    const answer = await this.api.player('/v1/me/bug-reports');
    const reports = (answer.json?.reports ?? []) as BugReportView[];
    if (subject) await this.tellFixed(subject, reports);
    return reports;
  }

  /** At a player's arrival: only when this device keeps a record for them (they reported here, or the app read their reports). */
  async checkFixed(): Promise<void> {
    const subject = this.subject();
    if (subject && (await this.store.get(this.fixedKey(subject)))) await this.mine();
  }

  private async tellFixed(subject: string, reports: BugReportView[]): Promise<void> {
    const { fixed, state } = newlyFixed(reports, await this.store.get<FixedState>(this.fixedKey(subject)));
    // A fix counts as told only when the game listens; otherwise it waits for the next look.
    const untold = new Set(this.fixedListeners.size ? [] : fixed.map((r) => r.id));
    await this.store.set(this.fixedKey(subject), { told: state.told.filter((id) => !untold.has(id)) } satisfies FixedState);
    for (const report of fixed) {
      for (const listener of this.fixedListeners) {
        try {
          listener(report);
        } catch {
          // the app's listener
        }
      }
    }
  }

  onFixed(listener: (report: BugReportView) => void): () => void {
    this.fixedListeners.add(listener);
    return () => this.fixedListeners.delete(listener);
  }

  resetBackoff(): void {
    this.waitUntil.clear();
  }
}
