import { Krtuworks, type SendResult } from './client.js';
import { CURRENT_TERMS, type KrtuworksAppConfig, type KrtuworksOptions, type Module, type Platform } from './config.js';
import { isKrtuworksError } from './errors.js';
import type { Family } from './families.js';

/**
 * The Krtuworks validator: one call checks the app's setup on this
 * machine, then runs a TEST round against the servers the way the build's release report counts it
 * (the server's release report): a guest signs in, a session opens, sends a heartbeat and ends, an
 * event batch, a save written and read back, a progress operation, a test bug report, the remote config
 * read. Every call names the build, so this run is what turns its report green on the partner console.
 *
 * The run uses the SDK's own store (the default one unless `store` names another): on this machine the
 * same TEST guest comes back run after run (new guests are limited per address and day). A new guest is
 * an adult that accepts the current terms (`birthDate`, `acceptedTerms` change that). The save goes to the
 * app's first save slot in TEST (`saveSlot` names another) as a new version; older ones stay in its history.
 * A run right after another waits out the slot's write limit (one write per 10 seconds) and saves again.
 */
export type ValidationStatus = 'PASSED' | 'FAILED' | 'SKIPPED';

export interface ValidationCheck {
  key: string;
  title: string;
  status: ValidationStatus;
  /** Why it failed or was skipped. */
  detail: string | null;
}

export interface ValidationReport {
  /** No check failed. */
  ok: boolean;
  build: string;
  checks: ValidationCheck[];
}

export interface ValidateOptions extends Omit<KrtuworksOptions, 'environment' | 'sessions'> {
  /** The slot to write and read back; default: the app's first save slot in TEST. */
  saveSlot?: string;
  /** A new TEST guest's date of birth (default 2000-01-01) and the terms it accepts (default the current ones). */
  birthDate?: string;
  acceptedTerms?: string;
}

const APP_ID = /^app_[0-9a-z]{20}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const BUILD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const TYPES = ['GAME', 'MOBILE_APP', 'WEB_APP', 'DESKTOP_APP'];
const PLATFORMS: readonly Platform[] = ['STEAM', 'EPIC', 'XBOX', 'PLAYSTATION', 'NINTENDO', 'IOS', 'ANDROID', 'WEB', 'WINDOWS', 'MACOS', 'LINUX'];
const SENDS = 5;
/** The server takes one write per slot per 10 s; the validator sits out a wait of at most WRITE_WAIT_S. */
const WRITE_LIMIT_S = 10;
const WRITE_WAIT_S = 15;

/** The event the validator sends: the first family whose module is on. */
const PROBES: ReadonlyArray<{ module: Module; type: Family; data: Record<string, unknown> }> = [
  { module: 'ui', type: 'screen_view', data: { screen: 'krtuworks-validator' } },
  { module: 'performance', type: 'performance', data: { fps: 60 } },
  { module: 'settings', type: 'settings', data: { language: 'en' } },
  { module: 'errors', type: 'error', data: { kind: 'other', message: 'Krtuworks validator', handled: true } },
  { module: 'economy', type: 'balance', data: { currency: 'validator', amount: 0 } },
  { module: 'items', type: 'interaction', data: { kind: 'other', name: 'krtuworks-validator' } },
  { module: 'progression', type: 'progression', data: { action: 'checkpoint', level: 'krtuworks-validator', checkpoint: 'validator' } },
  { module: 'combat', type: 'damage', data: { amount: 0 } },
];

const TITLES = {
  config: 'krtuworks-config.json names the app and its sign-in clients',
  build: 'The build is a version label the servers take',
  platform: 'The platform and the sign-in return are set',
  sign_in: 'Signed in as a TEST player',
  session: 'Opened a session, sent a heartbeat and ended it',
  events: 'An event batch was accepted',
  remote_config: 'Read the remote config',
  cloud_save: 'Wrote a save and read it back',
  progress: 'Sent a progress operation',
  bug_report: 'Sent a test bug report',
  sentry: 'A test error reached Sentry',
} as const;
type CheckKey = keyof typeof TITLES;
const ORDER = Object.keys(TITLES) as CheckKey[];
const RUN: CheckKey[] = ['sign_in', 'session', 'events', 'remote_config', 'cloud_save', 'progress', 'bug_report'];

const check = (key: CheckKey, status: ValidationStatus, detail: string | null = null): ValidationCheck => ({ key, title: TITLES[key], status, detail });

/** What is wrong with krtuworks-config.json for this kind of client, if anything. */
export function configProblems(config: KrtuworksAppConfig | null | undefined, clientKind: 'web' | 'native'): string[] {
  if (!config || typeof config !== 'object') return ['the config is missing'];
  const problems: string[] = [];
  if (!APP_ID.test(String(config.appId))) problems.push('appId is not an app_ id');
  if (!SLUG.test(String(config.slug))) problems.push("slug is not the app's address name");
  if (config.type !== undefined && !TYPES.includes(config.type)) problems.push(`type is one of ${TYPES.join(', ')}`);
  const field = clientKind === 'web' ? 'webClientId' : 'clientId';
  for (const env of ['TEST', 'LIVE'] as const) {
    const id = config.environments?.[env]?.[field];
    const want = `${config.slug}.${env.toLowerCase()}.${clientKind}`;
    if (!id) problems.push(`environments.${env} has no ${field}`);
    else if (id !== want) problems.push(`environments.${env}.${field} is ${id}, not ${want}`);
  }
  return problems;
}

/** What is wrong with the platform and, for a web page, the sign-in return address, if anything. */
export function platformProblems(platform: unknown, clientKind: 'web' | 'native', redirectUri: string | undefined): string[] {
  const problems: string[] = [];
  if (!PLATFORMS.includes(platform as Platform)) problems.push(`platform is one of ${PLATFORMS.join(', ')}`);
  if (clientKind === 'web') {
    let url: URL | null = null;
    try {
      url = redirectUri ? new URL(redirectUri) : null;
    } catch {
      url = null;
    }
    if (url?.protocol !== 'https:') problems.push("redirectUri is one of the web client's registered https return addresses");
  }
  return problems;
}

function why(err: unknown): string {
  if (isKrtuworksError(err)) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sends until nothing waits (another send may be running when this starts) and adds up what came back,
 * with what still waits at the end: the game's own SDK on the same store may have sent the validator's
 * item first, so "left this device unrefused" counts as sent.
 */
async function sendAll(krtu: Krtuworks): Promise<SendResult & { left: { events: number; progress: number; bugReports: number } }> {
  const total: SendResult = {
    progress: { applied: 0, stoppedBy: null, values: {} },
    bugs: { sent: 0, dropped: [] },
    events: { sent: 0, rejected: [], stoppedBy: null },
  };
  let left = { events: 0, progress: 0, bugReports: 0 };
  for (let round = 0; round < SENDS; round += 1) {
    const r = await krtu.flush();
    total.progress.applied += r.progress.applied;
    total.progress.stoppedBy = r.progress.stoppedBy;
    total.bugs.sent += r.bugs.sent;
    total.bugs.dropped.push(...r.bugs.dropped);
    total.bugs.stoppedBy = r.bugs.stoppedBy;
    total.events.sent += r.events.sent;
    total.events.rejected.push(...r.events.rejected);
    total.events.stoppedBy = r.events.stoppedBy;
    left = await krtu.waiting();
    if (!left.events && !left.progress && !left.bugReports) break;
    if (r.progress.stoppedBy || r.bugs.stoppedBy || r.events.stoppedBy) break;
  }
  return { ...total, left };
}

/** A send's verdict: sent, or left this device with no refusal; otherwise why it was not. */
export const sentOrWhy = (sent: number, waiting: number, stoppedBy: string | null | undefined): string | null =>
  sent > 0 || (!waiting && !stoppedBy) ? null : (stoppedBy ?? 'not sent');

/** Checks this app's setup and runs a TEST round against the servers; never throws. */
export async function validate(options: ValidateOptions): Promise<ValidationReport> {
  const clientKind = options.clientKind ?? (typeof window === 'undefined' ? 'native' : 'web');
  const build = String(options.build);
  const results = new Map<CheckKey, ValidationCheck>();
  const report = (): ValidationReport => {
    const checks = ORDER.map((key) => results.get(key) ?? check(key, 'SKIPPED', 'Not reached.'));
    return { ok: !checks.some((c) => c.status === 'FAILED'), build, checks };
  };
  const config = configProblems(options.config, clientKind);
  results.set('config', check('config', config.length ? 'FAILED' : 'PASSED', config.length ? config.join('; ') : null));
  const buildOk = BUILD.test(build);
  results.set('build', check('build', buildOk ? 'PASSED' : 'FAILED', buildOk ? null : 'build is the app version, like 1.4.2 or 1.4.2+381 (letters, digits, . _ + -, at most 64)'));
  const platform = platformProblems(options.platform, clientKind, options.redirectUri);
  results.set('platform', check('platform', platform.length ? 'FAILED' : 'PASSED', platform.length ? platform.join('; ') : null));
  results.set('sentry', check('sentry', 'SKIPPED', 'Sentry is not set up yet.'));
  if (config.length || !buildOk) {
    for (const key of RUN) results.set(key, check(key, 'SKIPPED', 'Fix the config and the build first.'));
    return report();
  }

  const { saveSlot, birthDate, acceptedTerms, ...sdk } = options;
  let krtu: Krtuworks | null = null;
  try {
    krtu = await Krtuworks.initialize({ ...sdk, clientKind, environment: 'TEST', sessions: false });
    const k = krtu;
    try {
      if (!k.player) await k.signInAsGuest({ birthDate: birthDate ?? '2000-01-01', acceptedTerms: acceptedTerms ?? CURRENT_TERMS });
      await k.ready();
      results.set('sign_in', check('sign_in', 'PASSED'));
    } catch (err) {
      results.set('sign_in', check('sign_in', 'FAILED', why(err)));
      for (const key of RUN.slice(1)) results.set(key, check(key, 'SKIPPED', 'No TEST player could sign in.'));
      return report();
    }
    const step = async (key: CheckKey, body: () => Promise<ValidationCheck | null>) => {
      try {
        results.set(key, (await body()) ?? check(key, 'PASSED'));
      } catch (err) {
        results.set(key, check(key, 'FAILED', why(err)));
      }
    };
    // The modules the owner left on in TEST; the read that counts for the report comes last, once the build is known there.
    await k.refreshConfig().catch(() => undefined);
    const modules = k.modules();

    await step('session', async () => {
      if (!modules.sessions) return check('session', 'SKIPPED', 'The sessions module is off in TEST.');
      await k.sessionRound();
      return null;
    });
    await step('events', async () => {
      const probe = PROBES.find((p) => modules[p.module]);
      if (!probe) return check('events', 'SKIPPED', 'Every telemetry module the validator can use is off in TEST.');
      if (!k.track(probe.type, probe.data)) return check('events', 'FAILED', 'The event was not kept: statistics are off for this player, or the owner switched this build off.');
      const { events: sent, left } = await sendAll(k);
      if (sent.rejected.length) return check('events', 'FAILED', sent.rejected.map((r) => r.code).join(', '));
      const not = sentOrWhy(sent.sent, left.events, sent.stoppedBy);
      return not ? check('events', 'FAILED', not) : null;
    });
    await step('cloud_save', async () => {
      if (!modules.cloudSave) return check('cloud_save', 'SKIPPED', 'The cloudSave module is off in TEST.');
      const { slots } = await k.files.list();
      const usable = slots.filter((s) => !s.retired && s.kind !== 'DEVICE_SETTINGS');
      const slot = saveSlot ? usable.find((s) => s.key === saveSlot) : usable[0];
      if (!slot) return saveSlot ? check('cloud_save', 'FAILED', `The app has no slot ${saveSlot} in TEST.`) : check('cloud_save', 'SKIPPED', 'The app has no save slot in TEST.');
      const bytes = new TextEncoder().encode(`krtuworks-validator ${new Date().toISOString()}`);
      const conditional = slot.kind === 'SAVE' || slot.kind === 'PROFILE';
      try {
        await k.files.save(slot.key, bytes, conditional ? { base: slot.file?.id ?? null } : {});
      } catch (err) {
        // A slot takes one write per 10 seconds: a run right after another waits and sends the same save again.
        const wait = isKrtuworksError(err, 'too_many_writes') ? (err.retryAfter ?? WRITE_LIMIT_S) : Infinity;
        if (wait > WRITE_WAIT_S) throw err;
        await new Promise((r) => setTimeout(r, wait * 1000 + 250));
        const resent = (await k.files.resume()).filter((u) => u.slot === slot.key);
        const refused = resent.find((u) => u.outcome !== 'saved');
        if (refused || !resent.length) return check('cloud_save', 'FAILED', refused?.code ?? 'not sent');
      }
      const back = await k.files.read(slot.key);
      const same = !!back && back.bytes.length === bytes.length && back.bytes.every((b, i) => b === bytes[i]);
      return same ? null : check('cloud_save', 'FAILED', `The save read back from ${slot.key} is not the one written.`);
    });
    await step('progress', async () => {
      if (!modules.achievements) return check('progress', 'SKIPPED', 'The achievements module is off in TEST.');
      const achievement = (await k.getProgress()).achievements.find((a) => !a.retired);
      if (!achievement) return check('progress', 'SKIPPED', 'The app has no achievement in TEST.');
      const before = k.progressRefusals.length;
      await k.unlockAchievement(achievement.key);
      const { progress: sent, left } = await sendAll(k);
      const refused = k.progressRefusals.slice(before).find((r) => r.key === achievement.key);
      if (refused) return check('progress', 'FAILED', refused.code);
      const not = sentOrWhy(sent.applied, left.progress, sent.stoppedBy);
      return not ? check('progress', 'FAILED', not) : null;
    });
    await step('bug_report', async () => {
      if (!modules.bugReports) return check('bug_report', 'SKIPPED', 'The bugReports module is off in TEST.');
      const { reportId } = await k.reportBug({ category: 'OTHER', description: 'A test report from the Krtuworks validator.' });
      const { bugs: sent, left } = await sendAll(k);
      const dropped = sent.dropped.find((d) => d.reportId === reportId);
      if (dropped) return check('bug_report', 'FAILED', dropped.code);
      const not = sentOrWhy(sent.sent, left.bugReports, sent.stoppedBy);
      return not ? check('bug_report', 'FAILED', not) : null;
    });
    await step('remote_config', async () => {
      await k.refreshConfig();
      return null;
    });
  } catch (err) {
    for (const key of RUN) if (!results.has(key)) results.set(key, check(key, 'FAILED', why(err)));
  } finally {
    await krtu?.shutdown().catch(() => undefined);
  }
  return report();
}
