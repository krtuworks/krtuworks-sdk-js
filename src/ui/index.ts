import type { Krtuworks } from '../client.js';
import { KrtuworksUi, type UiOptions } from './core.js';
import { defineElements, domHost, pageMemory } from './dom.js';

export {
  ACCOUNT_URL,
  KrtuworksUi,
  PRIVACY_URL,
  TERMS_URL,
  errorScreen,
  memoryMemory,
  type ChooseResult,
  type EnsureResult,
  type SaveCard,
  type SaveSummary,
  type UiAnswer,
  type UiDialog,
  type UiHost,
  type UiMemory,
  type UiOptions,
  type UiScreen,
} from './core.js';
export { UI_CSS, defineElements, domHost, pageMemory } from './dom.js';
export { MIN_AGE, ageOn, checkBirth, dateOrder, type DateOrder } from './format.js';
export { UI_TEXTS, textFor, type UiTextKey, type UiTexts } from './texts.js';

/**
 * The ready-made screens on this page: `await ui.ensurePlayer()` before the game starts, then
 * `<krtuworks-sign-in>` and `<krtuworks-account>` wherever the page wants them.
 */
export function createUi(client: Krtuworks, options: UiOptions = {}): KrtuworksUi {
  const ui = new KrtuworksUi(client, domHost({ texts: options.texts }), { memory: pageMemory(), ...options });
  defineElements(ui);
  return ui;
}
