import { KrtuworksError } from './errors.js';

/**
 * Reporting another player's profile picture (POST /v1/players/:subject/avatar-report): a reason from a
 * fixed list and an optional note. Krtuworks reviews the picture; the player who reports is never told
 * an outcome. One report per player and picture, at most 10 a day.
 */
export const AVATAR_REPORT_REASONS = ['SEXUAL', 'HATE', 'VIOLENCE', 'IMPERSONATION', 'SPAM', 'OTHER'] as const;
export type AvatarReportReason = (typeof AVATAR_REPORT_REASONS)[number];
export const AVATAR_REPORT_NOTE_MAX = 300;

export function avatarReportBody(subject: string, reason: string, note?: string | null): { path: string; json: { reason: AvatarReportReason; note?: string } } {
  if (typeof subject !== 'string' || !subject || subject.length > 200) throw new KrtuworksError('invalid_request', 'Name the player by the subject your app knows them by.', 400);
  if (!(AVATAR_REPORT_REASONS as readonly string[]).includes(reason)) throw new KrtuworksError('invalid_request', `reason is one of ${AVATAR_REPORT_REASONS.join(', ')}.`, 400);
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed.length > AVATAR_REPORT_NOTE_MAX) throw new KrtuworksError('invalid_request', `A note is at most ${AVATAR_REPORT_NOTE_MAX} characters.`, 400);
  return { path: `/v1/players/${encodeURIComponent(subject)}/avatar-report`, json: { reason: reason as AvatarReportReason, ...(trimmed ? { note: trimmed } : {}) } };
}
