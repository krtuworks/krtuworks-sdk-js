/**
 * Every sentence the ready-made screens show, in English. A game passes its own (any subset, any
 * language) as `texts`; `{name}` marks a value filled in at show time.
 */
export const UI_TEXTS = {
  'age.title': 'When were you born?',
  'age.day': 'Day',
  'age.month': 'Month',
  'age.year': 'Year',
  'age.accept': 'I accept the {terms} and the {privacy}.',
  'age.termsLink': 'Terms of Service',
  'age.privacyLink': 'Privacy Notice',
  'age.continue': 'Continue',
  'age.signIn': 'Sign in with Krtuworks ID',
  'age.invalid': 'Enter your date of birth.',
  'age.acceptNeeded': 'Accept the terms to continue.',
  'month.1': 'January',
  'month.2': 'February',
  'month.3': 'March',
  'month.4': 'April',
  'month.5': 'May',
  'month.6': 'June',
  'month.7': 'July',
  'month.8': 'August',
  'month.9': 'September',
  'month.10': 'October',
  'month.11': 'November',
  'month.12': 'December',
  'terms.title': 'Our terms changed',
  'terms.body': 'Accept the current {terms} and {privacy} to keep playing online.',
  'terms.accept': 'Accept',
  'underage.title': 'Online play needs you to be 13',
  'underage.body': "You can keep playing on this device. Progress stays here and isn't saved online.",
  'underage.play': 'Play offline',
  'signIn.button': 'Sign in with Krtuworks ID',
  'account.guest': 'Guest',
  'account.label': 'Krtuworks ID',
  'account.manage': 'Manage account',
  'account.link': 'Link a Krtuworks ID',
  'account.signOut': 'Sign out',
  'conflict.title': 'Two saves for {slot}',
  'conflict.body': 'Pick the one to keep. The other stays in your save history.',
  'conflict.here': 'This device',
  'conflict.there': 'Another device',
  'conflict.current': 'Current save',
  'conflict.merged': 'From your other account',
  'conflict.newer': 'Newer',
  'conflict.keep': 'Keep this save',
  'reminder.title': 'Keep your progress safe',
  'reminder.body': "Link a Krtuworks ID so a new phone or a reinstall doesn't lose it.",
  'reminder.later': 'Later',
  'reminder.link': 'Link',
  'error.title': "Couldn't sign in",
  'error.offline': "No connection to Krtuworks. Your game keeps going; we'll try again when you're back online.",
  'error.cancelled': 'Sign-in was cancelled.',
  'error.banned': "You can't play this game online.",
  'error.bannedReason': "You can't play this game online: {reason}",
  'error.bannedUntil': 'This ends on {date}.',
  'error.maintenance': 'Online features are down for maintenance.',
  'error.update': 'A new version is out. Update the game to keep playing online.',
  'error.busy': 'Too many new players right now. Try again in a moment.',
  'error.generic': 'Something went wrong. Try again in a moment.',
  'error.retry': 'Try again',
  'error.continue': 'Keep playing',
  'time.today': 'Today, {time}',
  'time.yesterday': 'Yesterday, {time}',
  'platform.STEAM': 'Steam',
  'platform.EPIC': 'Epic Games',
  'platform.WINDOWS': 'Windows',
  'platform.MACOS': 'Mac',
  'platform.LINUX': 'Linux',
  'platform.IOS': 'iPhone or iPad',
  'platform.ANDROID': 'Android',
  'platform.WEB': 'Browser',
  'platform.XBOX': 'Xbox',
  'platform.PLAYSTATION': 'PlayStation',
  'platform.NINTENDO': 'Nintendo Switch',
} as const;

export type UiTextKey = keyof typeof UI_TEXTS;
export type UiTexts = Partial<Record<UiTextKey, string>>;

/**
 * The sentence split around its `{name}` marks, for a screen that puts something other than text
 * there (the terms sentence's two links): `['I accept the ', {mark: 'terms'}, ' and the ', …]`.
 */
export function textSegments(texts: UiTexts, key: UiTextKey): Array<string | { mark: string }> {
  const template = texts[key] ?? UI_TEXTS[key];
  const out: Array<string | { mark: string }> = [];
  let at = 0;
  for (const found of template.matchAll(/\{([a-zA-Z]+)\}/g)) {
    if (found.index > at) out.push(template.slice(at, found.index));
    out.push({ mark: found[1] });
    at = found.index + found[0].length;
  }
  if (at < template.length) out.push(template.slice(at));
  return out;
}

/** The game's sentence for `key`, else the English one, with `{name}` filled from `vars`. */
export function textFor(texts: UiTexts, key: UiTextKey, vars: Record<string, string> = {}): string {
  const template = texts[key] ?? UI_TEXTS[key];
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => (name in vars ? vars[name] : whole));
}
