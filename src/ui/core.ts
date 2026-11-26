import type { Krtuworks } from '../client.js';
import { CURRENT_TERMS, ID_ORIGIN } from '../config.js';
import { isKrtuworksError, KrtuworksError } from '../errors.js';
import type { FileVersion } from '../files.js';
import type { Player } from '../identity.js';
import { birthYears, checkBirth, dateOrder, fileSize, isoDate, savedWhen, turnsThirteen, type DateOrder } from './format.js';
import { textFor, UI_TEXTS, type UiTextKey, type UiTexts } from './texts.js';

export const TERMS_URL = `${ID_ORIGIN}/legal/terms/latest`;
export const PRIVACY_URL = `${ID_ORIGIN}/legal/privacy/latest`;
export const ACCOUNT_URL = `${ID_ORIGIN}/`;

/** What the game can show about a save, read from its own bytes by `describeSave`. */
export interface SaveSummary {
  title?: string;
  lines?: string[];
  /** A picture of the save (an image address the page can load), shown above the lines. */
  image?: string | null;
}

export interface SaveCard {
  label: string;
  newer: boolean;
  when: string;
  size: string;
  summary: SaveSummary | null;
}

/** The screens the ready-made components draw; a game that draws its own gets the same models. */
export type UiScreen =
  | { kind: 'age'; order: DateOrder; years: number[]; termsUrl: string; privacyUrl: string; signIn: boolean; problem: 'invalid' | 'accept' | null }
  | { kind: 'terms'; termsUrl: string; privacyUrl: string }
  | { kind: 'underage' }
  | { kind: 'conflict'; slot: string; cards: [SaveCard, SaveCard] }
  | { kind: 'error'; message: string; retry: boolean };

export type UiAnswer =
  | { kind: 'birth'; year: number; month: number; day: number; accepted: boolean }
  | { kind: 'accept' }
  | { kind: 'signIn' }
  | { kind: 'offline' }
  | { kind: 'keep'; card: 0 | 1 }
  | { kind: 'retry' }
  | { kind: 'continue' };

export interface UiDialog {
  readonly answer: Promise<UiAnswer>;
  close(): void;
}

/** Draws the screens: the page's elements by default (`dom.ts`), or the game's own. */
export interface UiHost {
  show(screen: UiScreen): UiDialog;
  /** The "link a Krtuworks ID" prompt in a corner; it never stops the game. */
  remind(): { readonly answer: Promise<'link' | 'later'>; close(): void };
}

/** Small values the components keep between launches (the day a child turns 13). */
export interface UiMemory {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export function memoryMemory(): UiMemory {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => (value === null ? values.delete(key) : values.set(key, value)) };
}

export interface UiOptions {
  texts?: UiTexts;
  /** The device's language tag, for the date order and times (default `navigator.language`). */
  locale?: string;
  /** Plays as a guest when nobody signs in (default true); false starts the sign-in instead. */
  guests?: boolean;
  /** Shows the "link a Krtuworks ID" prompt when the SDK says it is time (default true). */
  linkReminder?: boolean;
  /** Reads a save's bytes into what its card shows (chapter, play time, a picture). */
  describeSave?: (slot: string, bytes: Uint8Array) => SaveSummary | null | Promise<SaveSummary | null>;
  memory?: UiMemory;
  now?: () => Date;
}

export type EnsureResult =
  | { status: 'signedIn'; player: Player }
  /** The page is going to the sign-in page; the player comes back to the redirect address. */
  | { status: 'redirecting' }
  /** No online player: the game keeps going on this device (under 13, no connection, the player chose to). */
  | { status: 'offline'; reason: 'underage' | 'unavailable' };

export type ChooseResult = { kept: 'here'; version: FileVersion } | { kept: 'there'; version: FileVersion; bytes: Uint8Array };

const UNDERAGE_KEY = 'krtu:ui:underageUntil';

/** The sentence an error screen shows for `err`, and whether trying again can help. */
export function errorScreen(err: unknown, texts: UiTexts, locale: string): { message: string; retry: boolean } {
  const t = (key: UiTextKey, vars?: Record<string, string>) => textFor(texts, key, vars);
  if (!isKrtuworksError(err)) return { message: t('error.generic'), retry: true };
  switch (err.code) {
    case 'network_error':
      return { message: t('error.offline'), retry: true };
    case 'sanctioned': {
      const reason = typeof err.details.reason === 'string' && err.details.reason ? err.details.reason : null;
      const endsAt = typeof err.details.endsAt === 'string' ? new Date(err.details.endsAt) : null;
      let message = reason ? t('error.bannedReason', { reason }) : t('error.banned');
      if (endsAt && !Number.isNaN(endsAt.getTime())) message += ` ${t('error.bannedUntil', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(endsAt) })}`;
      return { message, retry: false };
    }
    case 'guest_limit':
    case 'guest_capacity':
      return { message: t('error.busy'), retry: true };
    case 'account_deletion_pending':
      return { message: t('error.deletionPending'), retry: false };
    case 'account_deleted':
      return { message: t('error.deleted'), retry: false };
    case 'app_suspended':
    case 'maintenance':
      return { message: t('error.maintenance'), retry: true };
    case 'access_denied':
    case 'cancelled':
      return { message: t('error.cancelled'), retry: true };
    default:
      return { message: err.status === 0 ? t('error.offline') : t('error.generic'), retry: true };
  }
}

/** The ready-made screens' decisions: which one to show, what it says, what the SDK does with the answer. */
export class KrtuworksUi {
  readonly texts: UiTexts;
  readonly locale: string;
  private readonly memory: UiMemory;
  private readonly now: () => Date;
  private reminding = false;
  private readonly unsubscribe: () => void;

  constructor(
    readonly client: Krtuworks,
    readonly host: UiHost,
    private readonly options: UiOptions = {},
  ) {
    this.texts = options.texts ?? {};
    this.locale = options.locale ?? (typeof navigator === 'undefined' ? 'en' : navigator.language || 'en');
    this.memory = options.memory ?? memoryMemory();
    this.now = options.now ?? (() => new Date());
    this.unsubscribe = options.linkReminder === false ? () => undefined : client.onLinkReminder(() => void this.remind());
  }

  t(key: UiTextKey, vars?: Record<string, string>): string {
    return textFor(this.texts, key, vars);
  }

  /**
   * Makes sure someone is playing: the signed-in player, the guest on this device, or a new guest after
   * the age screen. Finishes a sign-in the page came back from. Never throws: without an online player
   * the answer says so and the game keeps going offline.
   */
  async ensurePlayer(): Promise<EnsureResult> {
    const returned = await this.finishReturn();
    if (returned) return returned;
    if (this.client.player) return { status: 'signedIn', player: this.client.player };
    const blocked = this.gateProblem();
    if (blocked) return this.failOffline(blocked);
    const until = this.memory.get(UNDERAGE_KEY);
    if (until && this.today() < until) return { status: 'offline', reason: 'underage' };
    if (this.options.guests === false) return this.signIn();
    let input: { birthDate?: string; acceptedTerms?: string } = {};
    for (;;) {
      try {
        return { status: 'signedIn', player: await this.client.signInAsGuest(input) };
      } catch (err) {
        const code = isKrtuworksError(err) ? err.code : '';
        if (code === 'birth_date_required' || code === 'invalid_birth_date') {
          const answer = await this.askAge(code === 'invalid_birth_date' ? 'invalid' : null);
          if (answer === 'signIn') return this.signIn();
          if (answer === 'underage') return { status: 'offline', reason: 'underage' };
          input = { birthDate: answer, acceptedTerms: CURRENT_TERMS };
          continue;
        }
        if (code === 'too_young') {
          if (input.birthDate) this.rememberUnderage(input.birthDate);
          await this.once({ kind: 'underage' });
          return { status: 'offline', reason: 'underage' };
        }
        const asked = isKrtuworksError(err) && typeof err.details.terms === 'string' ? err.details.terms : null;
        if (code === 'terms_required' && asked && asked !== input.acceptedTerms) {
          await this.once({ kind: 'terms', termsUrl: TERMS_URL, privacyUrl: PRIVACY_URL });
          input = { ...input, acceptedTerms: asked };
          continue;
        }
        const screen = errorScreen(err, this.texts, this.locale);
        const answer = await this.once({ kind: 'error', ...screen });
        if (answer.kind !== 'retry') return { status: 'offline', reason: 'unavailable' };
      }
    }
  }

  /** Goes to the Krtuworks ID sign-in page (a guest playing here comes along). */
  async signIn(): Promise<EnsureResult> {
    try {
      await this.client.signIn();
      return { status: 'redirecting' };
    } catch (err) {
      return this.failOffline(errorScreen(err, this.texts, this.locale));
    }
  }

  async signOut(): Promise<void> {
    await this.client.signOut();
  }

  /**
   * Saves `bytes` to `slot`; when another device saved it first, shows both saves and does what the
   * player picks. `there` hands back the other save's bytes for the game to load.
   */
  async save(slot: string, bytes: Uint8Array, options: { base?: string | null; name?: string } = {}): Promise<ChooseResult> {
    try {
      return { kept: 'here', version: await this.client.files.save(slot, bytes, { base: options.base }) };
    } catch (err) {
      const current = isKrtuworksError(err) && err.code === 'file_conflict' ? (err.details.current as FileVersion | undefined) : undefined;
      if (!current) throw err;
      return this.chooseSave({ slot, bytes, current, name: options.name });
    }
  }

  /** Two saves of `slot`: this device's `bytes` and the server's `current`. */
  async chooseSave(input: { slot: string; bytes: Uint8Array; current: FileVersion; name?: string }): Promise<ChooseResult> {
    const owner = this.playerSubject();
    let current = input.current;
    for (;;) {
      const read = await this.client.files.read(input.slot);
      this.assertSamePlayer(owner);
      if (!read?.version) return { kept: 'here', version: await this.client.files.save(input.slot, input.bytes, { base: null }) };
      const there = { ...current, id: read.version.id, generation: read.version.generation, savedAt: read.version.savedAt, sizeBytes: read.bytes.length };
      const theirs = read.bytes;
      const now = this.serverDate();
      const hereCard = await this.card(this.t('conflict.here'), now.toISOString(), input.bytes.length, input.slot, input.bytes);
      const thereLabel = there.platform ? `${this.t('conflict.there')} · ${this.platformName(there.platform)}` : this.t('conflict.there');
      const thereCard = await this.card(thereLabel, there.savedAt, there.sizeBytes, input.slot, theirs);
      const hereNewer = now.getTime() >= new Date(there.savedAt).getTime();
      hereCard.newer = hereNewer;
      thereCard.newer = !hereNewer;
      const answer = await this.once({ kind: 'conflict', slot: input.name ?? input.slot, cards: [hereCard, thereCard] });
      this.assertSamePlayer(owner);
      if (answer.kind === 'keep' && answer.card === 1) return { kept: 'there', version: there, bytes: theirs };
      try {
        return { kept: 'here', version: await this.client.files.save(input.slot, input.bytes, { base: there.id }) };
      } catch (err) {
        const newer = isKrtuworksError(err) && err.code === 'file_conflict' ? (err.details.current as FileVersion | undefined) : undefined;
        if (!newer) throw err;
        current = newer;
      }
    }
  }

  /** After two accounts were merged: every slot holding two versions asks the player which to keep. */
  async resolveMergedSaves(): Promise<Array<{ slot: string; kept: FileVersion }>> {
    const owner = this.playerSubject();
    const { slots } = await this.client.files.list();
    this.assertSamePlayer(owner);
    const out: Array<{ slot: string; kept: FileVersion }> = [];
    for (const slot of slots) {
      if (!slot.conflict || !slot.file) continue;
      const read = await this.client.files.read(slot.key);
      this.assertSamePlayer(owner);
      const currentCard = await this.card(this.t('conflict.current'), slot.file.savedAt, slot.file.sizeBytes, slot.key, read?.bytes ?? null);
      const mergedCard = await this.card(this.t('conflict.merged'), slot.conflict.savedAt, slot.conflict.sizeBytes, slot.key, null);
      const mergedNewer = new Date(slot.conflict.savedAt).getTime() > new Date(slot.file.savedAt).getTime();
      currentCard.newer = !mergedNewer;
      mergedCard.newer = mergedNewer;
      const answer = await this.once({ kind: 'conflict', slot: slot.name || slot.key, cards: [currentCard, mergedCard] });
      this.assertSamePlayer(owner);
      const keep = answer.kind === 'keep' && answer.card === 1 ? slot.conflict : slot.file;
      out.push({ slot: slot.key, kept: await this.client.files.resolve(slot.key, keep.id, slot.file.id) });
    }
    return out;
  }

  /** Shows the "link a Krtuworks ID" prompt; Link starts the sign-in. One at a time. */
  async remind(): Promise<void> {
    if (this.reminding || this.client.player?.kind !== 'guest') return;
    this.reminding = true;
    try {
      const prompt = this.host.remind();
      if ((await prompt.answer) === 'link') await this.signIn();
    } finally {
      this.reminding = false;
    }
  }

  platformName(platform: string): string {
    const key = `platform.${platform}`;
    return key in UI_TEXTS ? this.t(key as UiTextKey) : platform;
  }

  dispose(): void {
    this.unsubscribe();
  }

  private async finishReturn(): Promise<EnsureResult | null> {
    if (typeof window === 'undefined' || typeof window.location === 'undefined') return null;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('state') || !(url.searchParams.has('code') || url.searchParams.has('error'))) return null;
    let outcome: EnsureResult | 'failed';
    try {
      outcome = { status: 'signedIn', player: await this.client.completeSignIn(url) };
    } catch (err) {
      // Not a sign-in this page started (the page's own `code`/`state`, or a newer sign-in took over): left alone.
      if (isKrtuworksError(err) && (err.code === 'invalid_callback' || err.code === 'context_changed')) return null;
      outcome = 'failed';
      await this.once({ kind: 'error', message: errorScreen(err, this.texts, this.locale).message, retry: false });
    }
    for (const name of ['code', 'state', 'error', 'error_description', 'iss']) url.searchParams.delete(name);
    window.history.replaceState(window.history.state, '', url);
    return outcome === 'failed' ? null : outcome;
  }

  private gateProblem(): { message: string; retry: boolean } | null {
    const gate = this.client.gate();
    if (gate.maintenance?.enabled) return { message: gate.maintenance.message || this.t('error.maintenance'), retry: false };
    if (gate.updateRequired) return { message: this.t('error.update'), retry: false };
    return null;
  }

  private async failOffline(screen: { message: string; retry: boolean }): Promise<EnsureResult> {
    await this.once({ kind: 'error', message: screen.message, retry: false });
    return { status: 'offline', reason: 'unavailable' };
  }

  /** The age screen until it has a real answer: a birth date, the sign-in, or "under 13" (remembered). */
  private async askAge(first: 'invalid' | null): Promise<string | 'signIn' | 'underage'> {
    let problem: 'invalid' | 'accept' | null = first;
    for (;;) {
      const now = this.now();
      const answer = await this.once({ kind: 'age', order: dateOrder(this.locale), years: birthYears(now), termsUrl: TERMS_URL, privacyUrl: PRIVACY_URL, signIn: true, problem });
      if (answer.kind === 'signIn') return 'signIn';
      if (answer.kind !== 'birth') continue;
      const check = checkBirth(answer.year, answer.month, answer.day, now);
      if (check === 'invalid') {
        problem = 'invalid';
        continue;
      }
      const birthDate = isoDate(answer.year, answer.month, answer.day);
      if (check === 'underage') {
        this.rememberUnderage(birthDate);
        await this.once({ kind: 'underage' });
        return 'underage';
      }
      if (!answer.accepted) {
        problem = 'accept';
        continue;
      }
      return birthDate;
    }
  }

  /** Until the 13th birthday the age screen is not shown again; at least until tomorrow when the server and this device's clock disagree. */
  private rememberUnderage(birthDate: string): void {
    const until = turnsThirteen(birthDate);
    this.memory.set(UNDERAGE_KEY, until > this.today() ? until : this.today(1));
  }

  private today(plusDays = 0): string {
    const day = new Date(this.now().getTime() + plusDays * 86_400_000);
    return isoDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
  }

  private async card(label: string, savedAt: string, sizeBytes: number, slot: string, bytes: Uint8Array | null): Promise<SaveCard> {
    let summary: SaveSummary | null = null;
    if (bytes && this.options.describeSave) {
      try {
        summary = (await this.options.describeSave(slot, bytes)) ?? null;
      } catch {
        summary = null;
      }
    }
    return { label, newer: false, when: savedWhen(savedAt, this.serverDate(), this.locale, this.texts), size: fileSize(sizeBytes), summary };
  }

  /** Now on the server's clock (the save times are the server's); a test or game that sets `now` decides it itself. */
  private serverDate(): Date {
    return this.options.now ? this.options.now() : new Date(this.client.serverNow());
  }

  private playerSubject(): string | null {
    return this.client.player?.subject ?? null;
  }

  /** The player who opened a save screen is the one who answers it; otherwise their bytes or choice would reach another account. */
  private assertSamePlayer(owner: string | null): void {
    if (this.playerSubject() !== owner) throw new KrtuworksError('context_changed', 'The player changed while the save screen was open; nothing was saved.');
  }

  private async once(screen: UiScreen): Promise<UiAnswer> {
    const dialog = this.host.show(screen);
    try {
      return await dialog.answer;
    } finally {
      dialog.close();
    }
  }
}
