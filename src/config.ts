import { sampleInterval } from './positions.js';
import type { KrtuStore } from './store.js';

export type Environment = 'TEST' | 'LIVE';
export type Platform = 'STEAM' | 'EPIC' | 'XBOX' | 'PLAYSTATION' | 'NINTENDO' | 'IOS' | 'ANDROID' | 'WEB' | 'WINDOWS' | 'MACOS' | 'LINUX';
export type AppType = 'GAME' | 'MOBILE_APP' | 'WEB_APP' | 'DESKTOP_APP';

/**
 * `krtuworks-config.json`, downloaded from the app's "Credentials" page: nothing secret, only who the
 * app is, what kind of app it is and its players' sign-in clients per environment.
 */
export interface KrtuworksAppConfig {
  appId: string;
  slug: string;
  /** The game-only parts (levels, deaths) stay off in the other kinds. A file made before the field existed is a game's. */
  type?: AppType;
  /** `online`: the very first launch needs the server (see `Krtuworks.startup`); default `offline`: the game starts without it. */
  firstLaunch?: 'online' | 'offline';
  environments: Partial<Record<Environment, { clientId?: string; webClientId?: string }>>;
}

/** The modules only a game has: levels (progression) and deaths (combat). */
export const GAME_MODULES: readonly Module[] = ['progression', 'combat', 'positions'];

export interface DeviceInfo {
  os?: string;
  osVersion?: string;
  model?: string;
  gpu?: string;
  ramMb?: number;
  screenWidth?: number;
  screenHeight?: number;
}

function deviceText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.trim();
  if (text.length > max) {
    // Never cut a surrogate pair in half.
    const code = text.charCodeAt(max - 1);
    text = text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max).trim();
  }
  return text || undefined;
}

function deviceNumber(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : undefined;
}

/** The device as the server takes it: text trimmed and cut to its limits, empty parts and numbers out of range left out. */
export function cleanDevice(device: DeviceInfo): DeviceInfo {
  const clean: DeviceInfo = {
    os: deviceText(device.os, 40),
    osVersion: deviceText(device.osVersion, 40),
    model: deviceText(device.model, 80),
    gpu: deviceText(device.gpu, 120),
    ramMb: deviceNumber(device.ramMb, 10_000_000),
    screenWidth: deviceNumber(device.screenWidth, 100_000),
    screenHeight: deviceNumber(device.screenHeight, 100_000),
  };
  return Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined)) as DeviceInfo;
}

export interface KrtuworksOptions {
  config: KrtuworksAppConfig;
  environment: Environment;
  platform: Platform;
  /** The app's own version label (`1.4.2+381`), sent with every call. */
  build: string;
  /** `web` (a browser page: PKCE with an https redirect) or `native` (a desktop app: loopback redirect). Default: web in a browser. */
  clientKind?: 'web' | 'native';
  /** Overrides the client id the config names for the environment. */
  clientId?: string;
  /** Where the sign-in comes back: one of the web client's registered redirect addresses. */
  redirectUri?: string;
  store?: KrtuStore;
  fetch?: typeof fetch;
  device?: DeviceInfo;
  /** The player's language tag (`tr`, `pt-BR`); achievement names come in it when the app has them. */
  locale?: string;
  /** Opens a session and keeps it alive while the app runs. Default true. */
  sessions?: boolean;
  /** How often `samplePosition` tells where the player is, in seconds (1-600). Default 10. */
  positionSampleSeconds?: number;
  idOrigin?: string;
  devOrigin?: string;
}

export const ID_ORIGIN = 'https://id.krtuworks.com';
export const DEV_ORIGIN = 'https://dev.krtuworks.com';
/** The resource a player's tokens are for (the server). */
export const DEV_RESOURCE = 'https://dev.krtuworks.com';
export const ISSUER = 'https://id.krtuworks.com/oidc';
export const PLAYER_SCOPE = 'openid offline_access profile app:player';
export const GUEST_SCOPE = 'openid offline_access app:player';
/** The legal documents a new guest accepts, as this SDK version knows them; a newer set answers terms_required with the list. */
export const CURRENT_TERMS = 'TERMS:v1 PRIVACY:v1';

/** The SDK modules the owner switches per app (`config.modules`); a module that is off makes nothing. */
export const MODULES = [
  'sessions', 'progression', 'combat', 'economy', 'items', 'ui', 'performance', 'settings', 'errors',
  'bugReports', 'achievements', 'stats', 'cloudSave', 'remoteConfig', 'abTests', 'customEvents', 'leaderboards', 'presence', 'positions',
] as const;
export type Module = (typeof MODULES)[number];

/** Which module a ready-made event family belongs to; any other type is the app's own (customEvents). */
export const FAMILY_MODULE: Readonly<Record<string, Module>> = {
  screen_view: 'ui',
  button: 'ui',
  tutorial: 'ui',
  progression: 'progression',
  death: 'combat',
  damage: 'combat',
  position_sample: 'positions',
  economy: 'economy',
  balance: 'economy',
  item: 'items',
  interaction: 'items',
  performance: 'performance',
  settings: 'settings',
  error: 'errors',
};

export function moduleOfEventType(type: string): Module {
  return Object.prototype.hasOwnProperty.call(FAMILY_MODULE, type) ? FAMILY_MODULE[type]! : 'customEvents';
}

const BUILD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export interface ResolvedOptions {
  appId: string;
  slug: string;
  type: AppType;
  /** The app is a game (type GAME): levels and deaths are kept. */
  game: boolean;
  firstLaunch: 'online' | 'offline';
  environment: Environment;
  platform: Platform;
  build: string;
  clientId: string;
  clientKind: 'web' | 'native';
  redirectUri: string | null;
  idOrigin: string;
  devOrigin: string;
  device: DeviceInfo | null;
  locale: string | null;
  sessions: boolean;
  positionSampleSeconds: number;
}

export function resolveOptions(options: KrtuworksOptions): ResolvedOptions {
  const { config, environment } = options;
  if (!config || typeof config.appId !== 'string' || typeof config.slug !== 'string') throw new TypeError('config must be the app\'s krtuworks-config.json');
  if (environment !== 'TEST' && environment !== 'LIVE') throw new TypeError('environment is TEST or LIVE');
  if (typeof options.build !== 'string' || !BUILD.test(options.build)) throw new TypeError('build is the app\'s version label, like 1.4.2+381');
  const clientKind = options.clientKind ?? (typeof window === 'undefined' ? 'native' : 'web');
  const env = config.environments?.[environment] ?? {};
  const clientId = options.clientId ?? (clientKind === 'web' ? env.webClientId : env.clientId);
  if (!clientId) throw new TypeError(`krtuworks-config.json names no ${clientKind} client for ${environment}`);
  const type = config.type || 'GAME';
  return {
    appId: config.appId,
    slug: config.slug,
    type,
    game: type === 'GAME',
    firstLaunch: config.firstLaunch === 'online' ? 'online' : 'offline',
    environment,
    platform: options.platform,
    build: options.build,
    clientId,
    clientKind,
    redirectUri: options.redirectUri ?? null,
    idOrigin: (options.idOrigin ?? ID_ORIGIN).replace(/\/+$/, ''),
    devOrigin: (options.devOrigin ?? DEV_ORIGIN).replace(/\/+$/, ''),
    device: options.device ? cleanDevice(options.device) : null,
    locale: options.locale ? deviceText(options.locale, 35) ?? null : null,
    sessions: options.sessions ?? true,
    positionSampleSeconds: sampleInterval(options.positionSampleSeconds),
  };
}
