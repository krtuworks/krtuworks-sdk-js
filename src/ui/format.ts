import { textFor, type UiTexts } from './texts.js';

/** Krtuworks ID is for people aged 13 or older; the server refuses younger guests the same way. */
export const MIN_AGE = 13;
const OLDEST_YEARS = 120;

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

const MDY_REGIONS = new Set(['US', 'PH', 'FM', 'MH', 'PW', 'AS', 'GU', 'MP', 'PR', 'VI', 'UM']);
const YMD_LANGUAGES = new Set(['zh', 'ja', 'ko', 'hu', 'lt', 'mn']);
const YMD_REGIONS = new Set(['CN', 'TW', 'JP', 'KR', 'KP', 'HU', 'LT', 'MN']);

/** The order people in `locale` write a date in (`en-US` month first, `ja` year first, most day first). */
export function dateOrder(locale: string): DateOrder {
  const [language = '', ...rest] = locale.replace('_', '-').split('-');
  const region = rest.find((part) => /^[A-Za-z]{2}$/.test(part))?.toUpperCase() ?? '';
  if (MDY_REGIONS.has(region) || (language.toLowerCase() === 'en' && region === '')) return 'mdy';
  if (YMD_REGIONS.has(region) || YMD_LANGUAGES.has(language.toLowerCase())) return 'ymd';
  return 'dmy';
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function isoDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Whole years between `birthDate` and `today` (UTC), the way the server counts them. */
export function ageOn(birthDate: string, today: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  const tm = today.getUTCMonth() + 1;
  const td = today.getUTCDate();
  return today.getUTCFullYear() - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

export type BirthCheck = 'ok' | 'invalid' | 'underage';

/** The age screen's answer: a real date, no later than today and no more than 120 years back, 13 or older. */
export function checkBirth(year: number, month: number, day: number, today: Date): BirthCheck {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return 'invalid';
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return 'invalid';
  const age = ageOn(isoDate(year, month, day), today);
  if (age < 0 || age > OLDEST_YEARS) return 'invalid';
  return age < MIN_AGE ? 'underage' : 'ok';
}

/** The years the age screen offers: this year back to 120 years ago, newest first. */
export function birthYears(today: Date): number[] {
  const now = today.getUTCFullYear();
  return Array.from({ length: OLDEST_YEARS + 1 }, (_, i) => now - i);
}

/** The first day someone born on `birthDate` is 13 (a 29 February birthday counts from 1 March). */
export function turnsThirteen(birthDate: string): string {
  const [y, m, d] = birthDate.split('-').map(Number);
  const year = y + MIN_AGE;
  return d > daysInMonth(year, m) ? isoDate(year, m + 1, 1) : isoDate(year, m, d);
}

/** `12 KB`, `1.4 MB`. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** When a save was made: `Today, 21:40`, `Yesterday, 23:15`, else the date and time in `locale`. */
export function savedWhen(iso: string, now: Date, locale: string, texts: UiTexts): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((day(now) - day(at)) / 86_400_000);
  if (daysAgo === 0) return textFor(texts, 'time.today', { time });
  if (daysAgo === 1) return textFor(texts, 'time.yesterday', { time });
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
