import { Api } from './api.js';
import { avatarReportBody, type AvatarReportReason } from './avatarReports.js';
import { BugReports, type BugFlushResult, type BugReportInput, type BugReportView } from './bugs.js';
import { Clock } from './clock.js';
import { moduleOfEventType, resolveOptions, type AppType, type KrtuworksOptions, type Module, type ResolvedOptions } from './config.js';
import { KrtuworksError } from './errors.js';
import { ANON, EventQueue, type EventPosition, type FlushResult } from './events.js';
import type { Family, FamilyData } from './families.js';
import { Files } from './files.js';
import { Identity, type IdentityChange, type Player } from './identity.js';
import { Entitlements, type Entitlement } from './entitlements.js';
import { Presence, type PresenceResult } from './presence.js';
import { ProgressionTracker, type LevelRef } from './progression.js';
import { ProgressQueue, type SortOrder, type StatKind, type UploadMethod } from './progress.js';
import { RemoteConfig, olderThan, type Switch } from './remoteConfig.js';
import { SessionKeeper } from './sessions.js';
import { defaultStore, type KrtuStore } from './store.js';
import { errorOf, form, send } from './transport.js';

export interface TrackOptions {
  position?: EventPosition;
  /** The version of the app's own schema (or of its extension of a family). */
  schemaVersion?: number;
}

export interface Gate {
  maintenance: { enabled: boolean; message: string | null } | null;
  /** The owner's minimum version is newer than this build: the player must update from the store. */
  updateRequired: boolean;
  switchedOff: Switch | null;
}

export interface ProgressView {
  locale: string | null;
  stats: Array<{
    key: string; name: string; description: string | null; kind: StatKind; valueType: string; value: number | null; updatedAt: string | null;
    /** The stat on each platform (a Steam stat's API name); the native SDKs mirror it there. */
    platformIds: Record<string, string>;
  }>;
  achievements: Array<{
    key: string;
    id: string;
    name: string | null;
    description: string | null;
    hidden: boolean;
    retired: boolean;
    unlocked: boolean;
    unlockedAt: string | null;
    platformIds: Record<string, string>;
    iconUrl: string | null;
    lockedIconUrl: string | null;
  }>;
}

export type LeaderboardDisplay = 'NUMERIC' | 'TIME_SECONDS' | 'TIME_MILLISECONDS';

/** One of the app's leaderboards with the player's own score and rank (`rank`, `score`, `details` are null while the player is not on it). */
export interface LeaderboardView {
  key: string;
  name: string;
  description: string | null;
  sortOrder: SortOrder;
  display: LeaderboardDisplay;
  /** Present when the server tells it: the SDK folds waiting scores only for a board whose method it knows. */
  uploadMethod?: UploadMethod;
  importFromPlatform: boolean;
  /** The board on each platform (Steam's leaderboard name). */
  platformIds: Record<string, string>;
  score: number | null;
  /** Base64 of the bytes submitted with the score. */
  details: string | null;
  /** Competition rank: equal scores share one. */
  rank: number | null;
  /** Rows on the board. */
  entries: number;
}

export interface LeaderboardsView {
  locale: string | null;
  leaderboards: LeaderboardView[];
}

export interface LeaderboardEntry {
  rank: number;
  /** The id the app knows the player by (pairwise). */
  subject: string | null;
  /** The player's Krtuworks username; null when there is none or it could not be read (show "Player"). */
  name: string | null;
  score: number;
  /** Base64 of the bytes submitted with the score. */
  details: string | null;
  updatedAt: string;
  /** The row is the signed-in player's. */
  you: boolean;
}

export interface LeaderboardEntriesView {
  key: string;
  scope: 'global' | 'around';
  sortOrder: SortOrder;
  display: LeaderboardDisplay;
  total: number;
  entries: LeaderboardEntry[];
}

export interface LeaderboardEntriesOptions {
  /** `global` reads from `offset`; `around` centres the window on the player (default `global`). */
  scope?: 'global' | 'around';
  /** 1-100 (server default 25). */
  limit?: number;
  /** Global scope only. */
  offset?: number;
}

/** Why the SDK suggests a guest links a Krtuworks ID now. */
export type LinkReminderReason = 'first_achievement' | 'first_save' | 'play_time';

interface LinkReminderState {
  shownAt: number | null;
  achievement: boolean;
  save: boolean;
  playSeconds: number;
}

export interface MergeSettled {
  previousSubject: string;
  /** Saves the merged account left waiting on this device: the player chooses (files.adoptWaiting / discardWaiting). */
  waitingSaves: Array<{ uploadId: string; slot: string; savedAt: number }>;
}

export interface SendResult {
  progress: Awaited<ReturnType<ProgressQueue['flush']>>;
  bugs: BugFlushResult;
  events: FlushResult;
}

const FLUSH_MS = 30_000;
const CONFIG_MS = 5 * 60_000;
const PW = /^pw_[A-Za-z0-9_-]{8,120}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The Krtuworks SDK for web games and apps. One instance per app and environment:
 *
 *   const krtu = await Krtuworks.initialize({ config, environment: 'LIVE', platform: 'WEB', build: '1.0.0' });
 *   await krtu.signInAsGuest({ birthDate: '2001-04-02', acceptedTerms: CURRENT_TERMS });
 *   krtu.track('screen_view', { screen: 'menu' });
 *   await krtu.incrementStat('coins', 5);
 */
export class Krtuworks {
  readonly options: ResolvedOptions;
  readonly config: RemoteConfig;
  readonly files: Files;
  private readonly store: KrtuStore;
  private readonly clock = new Clock();
  private readonly identity: Identity;
  private readonly api: Api;
  private readonly events: EventQueue;
  private readonly progress: ProgressQueue;
  private readonly sessions: SessionKeeper;
  private readonly levels: ProgressionTracker;
  private readonly bugs: BugReports;
  private readonly presence: Presence;
  private readonly licences: Entitlements;
  private readonly fetchFn: typeof fetch;
  private optedOut = false;
  private experiments = new Map<string, unknown>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private configTimer: ReturnType<typeof setInterval> | null = null;
  private readonly mergeListeners = new Set<(merge: MergeSettled) => void>();
  private readonly reminderListeners = new Set<(reason: LinkReminderReason) => void>();
  private countedActive = 0;
  private sessionOwner: string | null = null;
  private readonly detach: Array<() => void> = [];
  private settling: Promise<void> = Promise.resolve();

  private constructor(options: KrtuworksOptions) {
    this.options = resolveOptions(options);
    this.store = options.store ?? defaultStore();
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.identity = new Identity({ opts: this.options, store: this.store, fetch: this.fetchFn, clock: this.clock });
    this.api = new Api(this.options, this.identity, this.fetchFn, this.clock);
    const subject = () => this.identity.player?.subject ?? null;
    this.events = new EventQueue({ opts: this.options, store: this.store, clock: this.clock, api: this.api, subject });
    this.progress = new ProgressQueue({ opts: this.options, store: this.store, api: this.api, subject });
    this.licences = new Entitlements(this.options.clientId, this.store, this.api, subject);
    this.sessions = new SessionKeeper(this.options, this.api, subject, (items) => this.licences.fromSession(items));
    this.config = new RemoteConfig(this.options, this.api, this.store);
    this.bugs = new BugReports(this.options, this.store, this.api, () => subject() ?? ANON, subject);
    this.presence = new Presence(this.options.clientId, this.store, this.api, subject);
    this.files = new Files(this.options, this.api, this.store, subject, () => this.identity.generation, () => void this.remindLinking('first_save').catch(() => undefined));
    this.levels = new ProgressionTracker(
      this.store,
      this.options.clientId,
      () => subject() ?? ANON,
      () => this.sessions.activeSeconds(),
      (data) => void this.track('progression', data),
    );
  }

  /** Makes the SDK ready: the player and the remote config this device kept, then the server in the background. */
  static async initialize(options: KrtuworksOptions): Promise<Krtuworks> {
    const krtu = new Krtuworks(options);
    krtu.sessionOwner = (await krtu.identity.load())?.subject ?? null;
    await krtu.config.load();
    await krtu.presence.load();
    await krtu.licences.load();
    krtu.detach.push(krtu.identity.onChange((change) => krtu.identityChanged(change)));
    krtu.watchPage();
    krtu.flushTimer = setInterval(() => void krtu.flush().catch(() => undefined), FLUSH_MS);
    krtu.configTimer = setInterval(() => void krtu.refreshConfig().catch(() => undefined), CONFIG_MS);
    for (const t of [krtu.flushTimer, krtu.configTimer]) (t as { unref?: () => void }).unref?.();
    void krtu.refreshConfig().catch(() => undefined);
    krtu.settling = krtu.settle();
    return krtu;
  }

  // ── Who plays ─────────────────────────────────────────────────────────────

  get player(): Player | null {
    return this.identity.player;
  }

  /** GAME, MOBILE_APP, WEB_APP or DESKTOP_APP, from krtuworks-config.json. */
  get appType(): AppType {
    return this.options.type;
  }

  onIdentityChange(listener: (change: IdentityChange) => void): () => void {
    return this.identity.onChange(listener);
  }

  /** Called when a merged account's waiting queues moved to the signed-in player (after the server confirmed). */
  onMergeSettled(listener: (merge: MergeSettled) => void): () => void {
    this.mergeListeners.add(listener);
    return () => this.mergeListeners.delete(listener);
  }

  /** Plays as a guest on this device; a new guest needs the age screen's answers. */
  async signInAsGuest(input: { birthDate?: string; acceptedTerms?: string } = {}): Promise<Player> {
    return this.identity.signInAsGuest(input);
  }

  /** The Krtuworks ID sign-in address (a guest playing here is carried along unless `carryGuest: false`). */
  async signInUrl(options: { redirectUri?: string; carryGuest?: boolean } = {}): Promise<string> {
    return this.identity.beginSignIn(options);
  }

  /** In a browser: goes to the sign-in page. */
  async signIn(options: { redirectUri?: string; carryGuest?: boolean } = {}): Promise<void> {
    const url = await this.signInUrl(options);
    await this.events.persist();
    window.location.assign(url);
  }

  /** Finishes the sign-in on the page the player came back to (`location.href` by default). */
  async completeSignIn(callbackUrl?: string | URL): Promise<Player> {
    const url = callbackUrl ?? (typeof window === 'undefined' ? undefined : window.location.href);
    if (!url) throw new TypeError('completeSignIn needs the address the player came back to');
    return this.identity.completeSignIn(url);
  }

  async signOut(): Promise<void> {
    await this.flush().catch(() => undefined);
    await this.sessions.end();
    await this.identity.signOut();
  }

  private identityChanged(change: IdentityChange): void {
    if (change.type === 'merged' || change.type === 'signed_out' || change.type === 'deletion_pending' || change.type === 'sanctioned') {
      this.sessions.close();
      this.presence.forget();
      this.licences.forget();
      this.sessionOwner = null;
      return;
    }
    // A guest that became a Krtuworks ID is the same player: its session goes on.
    if (this.sessionOwner !== change.player.subject) {
      this.sessions.close();
      this.presence.forget();
      this.licences.forget();
    }
    this.sessionOwner = change.player.subject;
    this.events.resetBackoff();
    this.progress.resetBackoff();
    this.bugs.resetBackoff();
    this.settling = this.settling.then(() => this.settle()).catch(() => undefined);
  }

  /**
   * What follows a player's arrival: the anonymous queues go to the first player; a merged account's
   * waiting queues move here once the server confirms the merge; the
   * session opens; unfinished saves are finished; the queues are sent. Without a player, a guest the
   * server could not make on an earlier launch is tried again.
   */
  private async settle(): Promise<void> {
    const player = this.identity.player;
    if (!player) {
      if ((await this.identity.meta()).guestRequest) await this.identity.signInAsGuest().catch(() => undefined);
      return;
    }
    await this.events.move(ANON, player.subject);
    await this.progress.move(ANON, player.subject);
    await this.bugs.move(ANON, player.subject);
    await this.settleMerges(player.subject).catch(() => undefined);
    await this.readOptOut().catch(() => undefined);
    await this.licences.ensureLoaded();
    if (this.options.sessions && this.config.moduleOn('sessions')) await this.sessions.open().catch(() => undefined);
    await this.refreshLicences();
    await this.refreshPresence();
    await this.files.resume().catch(() => undefined);
    await this.flush().catch(() => undefined);
    if (this.config.moduleOn('bugReports')) await this.bugs.checkFixed().catch(() => undefined);
  }

  private async settleMerges(subject: string): Promise<void> {
    for (const previous of await this.identity.waitingOwners()) {
      if (previous === subject || !PW.test(previous)) {
        await this.identity.forgetWaitingOwner(previous);
        continue;
      }
      const answer = await this.api.player('/v1/me/merge-check', { method: 'POST', json: { previousSubject: previous } });
      if (answer.json?.confirmed !== true) continue;
      await this.events.move(previous, subject);
      await this.progress.move(previous, subject);
      await this.bugs.move(previous, subject);
      await this.identity.forgetWaitingOwner(previous);
      const settled: MergeSettled = { previousSubject: previous, waitingSaves: await this.files.waitingFor(previous) };
      for (const listener of this.mergeListeners) {
        try {
          listener(settled);
        } catch {
          // the app's listener
        }
      }
    }
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────

  /**
   * Records an event (a family or the app's own type). Nothing is made when its module is off, the
   * owner switched this build's telemetry off, or the player turned statistics off. Returns whether
   * the event was kept.
   */
  track<F extends Family>(type: F, data: FamilyData[F], options?: TrackOptions): boolean;
  track(type: string, data?: Record<string, unknown>, options?: TrackOptions): boolean;
  track(type: string, data?: Record<string, unknown>, options: TrackOptions = {}): boolean {
    if (!EVENT_TYPE.test(type)) throw new TypeError(`"${type}" is not an event type (a lowercase letter, then lowercase letters, digits and _; at most 64)`);
    if (!this.telemetryAllowed(moduleOfEventType(type))) return false;
    const sessionId = this.sessions.session?.id;
    const made = this.events.add({
      type,
      ...(sessionId ? { sessionId } : {}),
      ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
      ...(options.position ? { position: options.position } : {}),
      ...(data && Object.keys(data).length ? { data } : {}),
    });
    this.bugs.noteEvent(made);
    return true;
  }

  private telemetryAllowed(module: Module): boolean {
    if (this.optedOut) return false;
    if (this.config.switchForBuild()) return false;
    return this.config.moduleOn(module);
  }

  /** Levels: the SDK adds the attempt, its times and deaths. Levels and deaths are for games only (nothing happens in an app). */
  readonly level = {
    start: async (level: LevelRef) => {
      if (this.options.game) await this.levels.start(level);
    },
    complete: (score?: number) => {
      if (this.options.game) this.levels.finish('complete', { score });
    },
    fail: (score?: number) => {
      if (this.options.game) this.levels.finish('fail', { score });
    },
    quit: () => {
      if (this.options.game) this.levels.finish('quit');
    },
    checkpoint: (name: string) => {
      if (this.options.game) this.levels.checkpoint(name);
    },
    restart: async () => {
      if (this.options.game) await this.levels.restart();
    },
  };

  /** A death, counted toward the level in play and told with its place. Games only: false in an app. */
  death(cause: string, extra: { enemy?: string; position?: EventPosition } = {}): boolean {
    if (!this.options.game) return false;
    const place = this.levels.noteDeath();
    return this.track(
      'death',
      { cause, ...(extra.enemy ? { enemy: extra.enemy } : {}), ...(place?.world ? { world: place.world } : {}), ...(place?.level ? { level: place.level } : {}) },
      { position: extra.position },
    );
  }

  /** An error the game caught, as the errors family tells it. */
  error(err: unknown, extra: { kind?: FamilyData['error']['kind']; fingerprint?: string; handled?: boolean } = {}): boolean {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.bugs.log(`error ${message}`);
    const place = this.levels.inPlay;
    return this.track('error', {
      kind: extra.kind ?? 'exception',
      message: message.slice(0, 500),
      ...(extra.fingerprint ? { fingerprint: extra.fingerprint.slice(0, 100) } : {}),
      handled: extra.handled ?? true,
      ...(place?.world ? { world: place.world } : {}),
      ...(place?.level ? { level: place.level } : {}),
    });
  }

  // ── Bug reports ───────────────────────────────────────────────────────────

  /**
   * A bug report from the player (the categories are a fixed menu). The SDK adds the platform, build,
   * device, language, level in play, frame rate, the last 50 events and the log lines. The report is
   * kept on this device first and sent when it can be, its screenshot right after it; a player sends at
   * most 5 an hour and 20 a day in an app (more wait with `too_many_reports`). Refused at once when the
   * owner turned bug reports off (`module_disabled`) or the input can never be taken (`invalid_request`).
   */
  async reportBug(input: BugReportInput): Promise<{ reportId: string }> {
    if (!this.config.moduleOn('bugReports')) throw new KrtuworksError('module_disabled', 'Bug reports are off in this app.', 403);
    const place = this.levels.inPlay;
    const level = place ? [place.world, place.level, place.part].filter(Boolean).join('/') : null;
    const made = await this.bugs.report(input, level);
    this.scheduleFlush();
    return made;
  }

  /** A line for the bug reports' log (kept in memory, the last 32 KB; sent only inside a report the player makes). */
  log(message: string): void {
    this.bugs.log(message);
  }

  /** The player's bug reports in this app, newest first, with their status and the build a fix shipped in. */
  async myBugReports(): Promise<BugReportView[]> {
    return this.bugs.mine();
  }

  /**
   * Called for each of the player's reports that was fixed since the app last looked (at a player's
   * arrival, and on myBugReports): the game may tell the player "fixed in <fixedIn>".
   */
  onBugFixed(listener: (report: BugReportView) => void): () => void {
    return this.bugs.onFixed(listener);
  }

  /**
   * Reports another player's profile picture: `subject` is the id your app knows them by (another
   * player of this app, e.g. from your game server), the reason one of AVATAR_REPORT_REASONS, an
   * optional note of at most 300 characters. Krtuworks reviews it; the reporter is never told an
   * outcome. Once per player and picture (again answers `already: true`), at most 10 a day
   * (`too_many_reports`). Needs a connection: nothing waits on this device.
   */
  async reportAvatar(subject: string, reason: AvatarReportReason, note?: string): Promise<{ already: boolean }> {
    const { path, json } = avatarReportBody(subject, reason, note);
    const answer = await this.api.player(path, { method: 'POST', json });
    return { already: (answer.json as { already?: unknown } | null)?.already === true };
  }

  /** The player's statistics choice in this app (on by default). Off: no event is made or kept. */
  async getTelemetryOptOut(): Promise<boolean> {
    await this.readOptOut();
    return this.optedOut;
  }

  async setTelemetryOptOut(optedOut: boolean): Promise<void> {
    await this.api.player('/v1/me/telemetry-opt-out', { method: 'PUT', json: { optedOut } });
    this.optedOut = optedOut;
    await this.store.set(this.optOutKey(), optedOut);
  }

  private optOutKey(): string {
    return `krtu:${this.options.clientId}:optout:${this.identity.player?.subject ?? ANON}`;
  }

  private async readOptOut(): Promise<void> {
    const kept = await this.store.get<boolean>(this.optOutKey());
    if (kept !== undefined) this.optedOut = kept;
    if (!this.identity.player) return;
    const answer = await this.api.player('/v1/me/telemetry-opt-out');
    this.optedOut = answer.json?.optedOut === true;
    await this.store.set(this.optOutKey(), this.optedOut);
  }

  // ── Progress ──────────────────────────────────────────────────────────────

  /** Adds to a SUM stat. Kept on the device until the server has it; never lost, never counted twice. */
  async incrementStat(key: string, by = 1): Promise<void> {
    await this.progress.report('add', key, by);
    this.scheduleFlush();
  }

  /** Reports a value to a MAX, MIN or LATEST stat. */
  async setStat(key: string, value: number): Promise<void> {
    await this.progress.report('set', key, value);
    this.scheduleFlush();
  }

  /**
   * Submits the player's score to a leaderboard (a whole number below 10^15; `details` 1-64 bytes the game
   * keeps with it). Kept on the device until the server has it, like a stat; the server decides what the
   * board keeps (KEEP_BEST or FORCE_UPDATE) and mirrors to the platform itself.
   */
  async submitScore(key: string, value: number, options: { details?: Uint8Array } = {}): Promise<void> {
    await this.progress.submitScore(key, value, options.details);
    this.scheduleFlush();
  }

  async unlockAchievement(key: string): Promise<void> {
    await this.progress.unlock(key);
    this.scheduleFlush();
    await this.remindLinking('first_achievement').catch(() => undefined);
  }

  /** The app's stats and achievements with the player's values (names in the SDK's locale where the app has them). */
  async getProgress(): Promise<ProgressView> {
    const answer = await this.api.player('/v1/me/progress', { query: { locale: this.options.locale } });
    const view = answer.json as unknown as ProgressView;
    await this.progress.learnKinds(view.stats ?? []);
    return view;
  }

  /** The app's leaderboards with the player's own score and rank (names in the SDK's locale where the app has them). */
  async getLeaderboards(options: { locale?: string } = {}): Promise<LeaderboardsView> {
    const answer = await this.api.player('/v1/me/leaderboards', { query: { locale: options.locale ?? this.options.locale } });
    const view = answer.json as unknown as LeaderboardsView;
    await this.progress.learnBoards(view.leaderboards ?? []);
    return view;
  }

  /** A leaderboard's rows in its order: from `offset`, or the window around the player. */
  async getLeaderboardEntries(key: string, options: LeaderboardEntriesOptions = {}): Promise<LeaderboardEntriesView> {
    const answer = await this.api.player(`/v1/leaderboards/${encodeURIComponent(key)}/entries`, {
      query: { scope: options.scope, limit: options.limit, offset: options.offset },
    });
    return answer.json as unknown as LeaderboardEntriesView;
  }

  /**
   * Lines achievements up with a platform's: unlocks here what the platform has, answers what to unlock
   * there (`toPlatform`) and what support took back here that the platform still has (`toClear`). The open
   * session goes with it: the server mirrors only with the platform account the session proved (Steam:
   * required, `409 platform_link_mismatch {state}` when that account is not mirrored for this player).
   */
  async syncPlatformAchievements(unlocked: string[]): Promise<{ unlockedHere: string[]; toPlatform: string[]; toClear: string[] }> {
    const session = this.sessions.session ?? (this.options.sessions && this.config.moduleOn('sessions') ? await this.sessions.open() : null);
    const answer = await this.api.player('/v1/me/progress/platform-sync', {
      method: 'POST',
      json: { platform: this.options.platform, build: this.options.build, unlocked, ...(session ? { sessionId: session.id } : {}) },
    });
    return {
      unlockedHere: (answer.json?.unlockedHere as string[]) ?? [],
      toPlatform: (answer.json?.toPlatform as string[]) ?? [],
      toClear: (answer.json?.toClear as string[]) ?? [],
    };
  }

  /** Progress the server refused for good (a retired stat, a wrong value): for the game's own diagnostics. */
  get progressRefusals() {
    return [...this.progress.refusals];
  }

  // ── What the player owns (the game and its DLCs) ──────────────────────────

  /** Only a Steam game has licences the server reads from the platform today; a launch asks for them once the player is here. */
  private async refreshLicences(): Promise<void> {
    if (this.options.game && this.options.platform === 'STEAM') await this.licences.refresh().catch(() => undefined);
  }

  /**
   * The player's licences as the server last said them (kept on this device, so the last answer of an
   * earlier launch is here when the server cannot be reached): the game (`sku` base) first, then the
   * DLCs. `checked` marks what the server confirmed with the platform in this launch. Empty for an app
   * that is not a game.
   */
  entitlements(): Entitlement[] {
    return this.options.game ? this.licences.list() : [];
  }

  /** Asks the server for the stored licences now (`GET /v1/me/entitlements`) and keeps the answer. Throws when the server cannot be reached. */
  async refreshEntitlements(): Promise<Entitlement[]> {
    return this.options.game ? this.licences.refresh() : [];
  }

  /**
   * Whether the player owns the DLC with this product key: what the server confirmed with the platform
   * in this launch; else the last answer the server gave (a browser has no platform client of its own
   * to ask). False for an unknown key and for an app that is not a game.
   */
  ownsDlc(key: string): boolean {
    return this.options.game && this.licences.ownsDlc(key);
  }

  // ── Rich presence ─────────────────────────────────────────────────────────

  private presenceOn(): boolean {
    return this.options.game && this.config.moduleOn('presence');
  }

  private async refreshPresence(): Promise<void> {
    if (this.presenceOn()) await this.presence.refresh().catch(() => undefined);
  }

  /**
   * Shows what the player is doing (a state the owner declared on the console, with its parameters).
   * Never throws for the reasons in the result. A browser has no platform presence to write, so a call
   * that passes every rule answers `no_platform`. `LEVEL` and `SESSION_MINUTES` fill themselves when
   * the state declares them and the call does not give them.
   */
  async setPresence(key: string, params: Record<string, string | number> = {}): Promise<PresenceResult> {
    if (!this.options.game) return { applied: false, reason: 'not_game' };
    if (!this.config.moduleOn('presence')) return { applied: false, reason: 'module_disabled' };
    const reason = this.presence.check(
      key,
      params,
      { LEVEL: () => this.levels.inPlay?.level ?? null, SESSION_MINUTES: () => String(Math.floor(this.sessions.sessionActiveSeconds() / 60)) },
      (line) => this.bugs.log(line),
    );
    return { applied: false, reason: reason ?? 'no_platform' };
  }

  /** Takes the shown presence away. A browser shows none, so there is nothing to clear. */
  clearPresence(): void {}

  /** Tells the platform the player's party (`null` leaves it). A browser has no platform presence, so this does nothing. */
  setPresenceGroup(_groupId: string | null, _size?: number): void {}

  /** Whether the player shows their presence; null until the server has said (or when the module is off). */
  presenceVisible(): boolean | null {
    return this.presenceOn() ? this.presence.visible() : null;
  }

  /** The player's choice to show their presence. Throws `module_disabled` when the owner turned presence off. */
  async setPresenceVisible(visible: boolean): Promise<void> {
    if (!this.presenceOn()) throw new KrtuworksError('module_disabled', 'Rich presence is off in this app.', 403);
    await this.presence.setVisible(visible);
  }

  // ── The app's settings, A/B tests, status ─────────────────────────────────

  async refreshConfig(): Promise<void> {
    await this.config.refresh();
    await this.refreshPresence();
  }

  /** The owner's gates for this build: maintenance, a newer minimum version, a switch. */
  gate(): Gate {
    const config = this.config.value?.config;
    const maintenance = config?.maintenance ?? null;
    return {
      maintenance: maintenance ? { enabled: maintenance.enabled === true, message: maintenance.message ?? null } : null,
      updateRequired: typeof config?.minVersion === 'string' ? olderThan(this.options.build, config.minVersion) : false,
      switchedOff: this.config.switchForBuild(),
    };
  }

  /** The modules the owner left on (all of them until the config says otherwise; in an app the game-only ones are off). */
  modules(): Record<Module, boolean> {
    return this.config.modules();
  }

  /** The player's A/B groups; their values take over the config's (`value`). */
  async refreshExperiments(): Promise<Array<{ key: string; configKey: string; group: string; value: unknown }>> {
    const answer = await this.api.player('/v1/me/experiments');
    const list = (answer.json?.experiments as Array<{ key: string; configKey: string; group: string; value: unknown }>) ?? [];
    this.experiments = new Map(list.map((e) => [e.configKey, e.value]));
    return list;
  }

  /** A remote config value, the player's A/B group's when one varies it. */
  value<T = unknown>(key: string, fallback?: T): T | undefined {
    return this.experiments.has(key) ? (this.experiments.get(key) as T) : this.config.get<T>(key, fallback);
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const answer = await this.api.player('/v1/me/status', { query: { platform: this.options.platform } });
    return answer.json ?? {};
  }

  // ── The player's card ─────────────────────────────────────────────────────

  async getProfile(): Promise<{ fields: Record<string, string | number | boolean>; updatedAt: string | null }> {
    const answer = await this.api.player('/v1/me/profile');
    return { fields: (answer.json?.fields as Record<string, string | number | boolean>) ?? {}, updatedAt: (answer.json?.updatedAt as string | null) ?? null };
  }

  /** Writes the named fields of the player's card (null clears one). */
  async updateProfile(fields: Record<string, string | number | boolean | null>): Promise<{ fields: Record<string, string | number | boolean>; updatedAt: string | null }> {
    const answer = await this.api.player('/v1/me/profile', { method: 'PUT', json: { fields, platform: this.options.platform, build: this.options.build } });
    return { fields: (answer.json?.fields as Record<string, string | number | boolean>) ?? {}, updatedAt: (answer.json?.updatedAt as string | null) ?? null };
  }

  // ── A guest's own account (no e-mail, no account site: the device key proves it) ──

  private async guestCall(path: string, purpose: 'delete' | 'cancel_deletion' | 'export_download', extra: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const assertion = await this.identity.guestProof(purpose);
    const { body, headers } = form({ client_id: this.options.clientId, assertion, ...extra });
    const answer = await send(this.fetchFn, this.clock, `${this.options.idOrigin}${path}`, { method: 'POST', headers, body });
    if (answer.status >= 400) throw errorOf(answer);
    return answer.json ?? {};
  }

  /** Asks to delete this guest account (90 days; signing in as the guest is then only for cancelling or the data copy). */
  async requestGuestDeletion(): Promise<{ deletionDate: string }> {
    await this.flush().catch(() => undefined);
    const answer = await this.guestCall('/v1/guest/deletion', 'delete', { confirm: 'true' });
    this.sessions.close();
    return { deletionDate: String(answer.deletionDate) };
  }

  async cancelGuestDeletion(): Promise<{ status: string }> {
    const answer = await this.guestCall('/v1/guest/deletion/cancel', 'cancel_deletion');
    return { status: String(answer.status) };
  }

  /** The guest's data copy: asks for a new one with `request`; a ready copy comes with a 15-minute download address. */
  async guestDataExport(options: { request?: boolean } = {}): Promise<Record<string, unknown>> {
    return this.guestCall('/v1/guest/data-export', 'export_download', options.request ? { request: 'true' } : {});
  }

  // ── "Link a Krtuworks ID" for guests ───────────────────────

  /**
   * Called at the moments a guest has something to lose (the first achievement, the first save, a while
   * of play) when the app's `linkReminder` setting says it is time: the game shows its own prompt and,
   * if the player agrees, calls `signIn()`. Remote config `linkReminder`: `{ enabled, afterMinutes, everyDays }`
   * (default on, 30 minutes, every 3 days).
   */
  onLinkReminder(listener: (reason: LinkReminderReason) => void): () => void {
    this.reminderListeners.add(listener);
    return () => this.reminderListeners.delete(listener);
  }

  private async remindLinking(reason: LinkReminderReason): Promise<void> {
    const player = this.identity.player;
    if (player?.kind !== 'guest' || !this.reminderListeners.size) return;
    const setting = (this.config.get<{ enabled?: boolean; afterMinutes?: number; everyDays?: number }>('linkReminder') ?? {}) as {
      enabled?: boolean;
      afterMinutes?: number;
      everyDays?: number;
    };
    if (setting.enabled === false) return;
    const key = `krtu:${this.options.clientId}:linkReminder:${player.subject}`;
    const state = (await this.store.get<LinkReminderState>(key)) ?? { shownAt: null, achievement: false, save: false, playSeconds: 0 };
    const active = this.sessions.activeSeconds();
    state.playSeconds += Math.max(0, active - this.countedActive);
    this.countedActive = active;
    let due = false;
    if (reason === 'first_achievement' && !state.achievement) due = state.achievement = true;
    if (reason === 'first_save' && !state.save) due = state.save = true;
    if (reason === 'play_time') due = state.playSeconds >= (setting.afterMinutes ?? 30) * 60;
    const quietMs = (setting.everyDays ?? 3) * 86_400_000;
    const show = due && (state.shownAt === null || Date.now() - state.shownAt >= quietMs);
    if (show) state.shownAt = Date.now();
    await this.store.set(key, state);
    if (!show) return;
    for (const listener of this.reminderListeners) {
      try {
        listener(reason);
      } catch {
        // the app's listener
      }
    }
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  private flushSoon: ReturnType<typeof setTimeout> | null = null;

  private scheduleFlush(): void {
    this.flushSoon ??= setTimeout(() => {
      this.flushSoon = null;
      void this.flush().catch(() => undefined);
    }, 2000);
    (this.flushSoon as { unref?: () => void }).unref?.();
  }

  private flushing: Promise<SendResult> | null = null;

  /**
   * Sends what waits: progress first (it must not wait behind telemetry), then bug reports, then events.
   * One send at a time: a call made while one runs gets that one's result.
   */
  async flush(): Promise<SendResult> {
    this.flushing ??= this.send().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async send(): Promise<SendResult> {
    await this.remindLinking('play_time').catch(() => undefined);
    const progress = await this.progress.flush();
    const blocked = this.config.switchForBuild()?.mode === 'ALL';
    const bugs = blocked ? { sent: 0, dropped: [], stoppedBy: 'switched_off' } : await this.bugs.flush();
    const events = blocked ? { sent: 0, rejected: [], stoppedBy: 'switched_off' } : await this.events.flush({ errorsOn: this.config.moduleOn('errors') });
    return { progress, bugs, events };
  }

  /** @internal The validator's round: a session opened, kept alive once and ended, every step answered. */
  async sessionRound(): Promise<void> {
    await this.sessions.round();
  }

  /** What waits on this device for the signed-in player (or the anonymous queue). */
  async waiting(): Promise<{ events: number; progress: number; bugReports: number }> {
    const owner = this.identity.player?.subject ?? ANON;
    return { events: await this.events.size(owner), progress: await this.progress.waiting(owner), bugReports: await this.bugs.waiting() };
  }

  private watchPage(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const visibility = () => {
      const visible = document.visibilityState === 'visible';
      this.sessions.setForeground(visible);
      if (!visible) void this.events.persist().catch(() => undefined);
    };
    const pagehide = () => {
      this.levels.finish('quit');
      void this.events.persist().catch(() => undefined);
      void this.sessions.end();
    };
    const online = () => {
      this.events.resetBackoff();
      this.progress.resetBackoff();
      this.bugs.resetBackoff();
      void this.flush().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('online', online);
    this.detach.push(
      () => document.removeEventListener('visibilitychange', visibility),
      () => window.removeEventListener('pagehide', pagehide),
      () => window.removeEventListener('online', online),
    );
  }

  /** Waits for the work that follows a player's arrival (tests, or a game that wants to know it is done). */
  async ready(): Promise<void> {
    await this.settling;
  }

  /** Stops the SDK: the level in play ends as a quit, the session ends, what waits is written to the store. */
  async shutdown(): Promise<void> {
    for (const t of [this.flushTimer, this.configTimer]) if (t) clearInterval(t);
    if (this.flushSoon) clearTimeout(this.flushSoon);
    for (const off of this.detach.splice(0)) off();
    this.levels.finish('quit');
    await this.events.persist();
    await this.sessions.end();
  }
}

