import type { Player } from '../identity.js';
import { ACCOUNT_URL, type KrtuworksUi, type SaveCard, type UiAnswer, type UiDialog, type UiHost, type UiMemory, type UiScreen } from './core.js';
import { daysInMonth } from './format.js';
import { textFor, textSegments, type UiTextKey, type UiTexts } from './texts.js';

/**
 * The screens as page elements. Every colour, corner and font is a CSS variable a page can set on
 * `:root` or on the elements: `--kw-surface`, `--kw-raised`, `--kw-line`, `--kw-text`, `--kw-muted`,
 * `--kw-accent`, `--kw-accent-ink`, `--kw-danger`, `--kw-radius`, `--kw-radius-sm`, `--kw-font`, `--kw-backdrop`.
 */
export const UI_CSS = `
:host { all: initial; }
.kw { font-family: var(--kw-font, -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif); color: var(--kw-text, #f5f5f7); font-size: 15px; line-height: 1.5; }
.backdrop { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 16px; background: var(--kw-backdrop, rgba(0,0,0,.55)); }
.card { box-sizing: border-box; width: min(420px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--kw-surface, #1b1b1e); border: 1px solid var(--kw-line, #34343a); border-radius: var(--kw-radius, 16px); padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
.card.wide { width: min(560px, 100%); }
h2 { font-size: 19px; font-weight: 650; margin: 0 0 6px; letter-spacing: -.01em; }
p { margin: 0 0 16px; color: var(--kw-muted, #a1a1a6); font-size: 14px; }
a { color: var(--kw-accent, #ffbf23); font-weight: 600; text-decoration: none; }
a:hover { text-decoration: underline; }
.row { display: flex; gap: 8px; }
.row > label { flex: 1; min-width: 0; }
.field-name { display: block; font-size: 12.5px; color: var(--kw-muted, #a1a1a6); margin: 0 0 6px; }
select { width: 100%; height: 44px; padding: 0 10px; font: inherit; font-size: 16px; color: var(--kw-text, #f5f5f7); background: var(--kw-raised, #26262b); border: 1px solid var(--kw-line, #34343a); border-radius: var(--kw-radius-sm, 10px); }
.check { display: flex; gap: 10px; align-items: flex-start; margin: 16px 0 18px; font-size: 14px; cursor: pointer; }
.check input { width: 20px; height: 20px; margin: 1px 0 0; accent-color: var(--kw-accent, #ffbf23); flex: none; }
.stack { display: grid; gap: 8px; }
button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 46px; padding: 0 16px; border: 0; border-radius: var(--kw-radius-sm, 10px); font: inherit; font-weight: 650; font-size: 15px; cursor: pointer; background: var(--kw-accent, #ffbf23); color: var(--kw-accent-ink, #1d1d1f); }
button.ghost { background: transparent; color: var(--kw-text, #f5f5f7); border: 1px solid var(--kw-line, #34343a); }
button:focus-visible, .save:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid var(--kw-accent, #ffbf23); outline-offset: 2px; }
.problem { border-left: 3px solid var(--kw-danger, #ff6b5e); padding: 2px 0 2px 12px; margin: 0 0 14px; font-size: 14px; color: var(--kw-text, #f5f5f7); }
.saves { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 0 14px; }
@media (max-width: 480px) { .saves { grid-template-columns: 1fr; } }
.save { all: unset; box-sizing: border-box; display: grid; gap: 8px; align-content: start; padding: 14px; cursor: pointer; background: var(--kw-raised, #26262b); border: 1px solid var(--kw-line, #34343a); border-radius: var(--kw-radius-sm, 10px); }
.save[aria-pressed="true"] { border-color: var(--kw-accent, #ffbf23); box-shadow: 0 0 0 2px var(--kw-accent, #ffbf23); }
.save img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; }
.save-name { font-weight: 650; font-size: 14px; }
.meta { font-size: 12.5px; color: var(--kw-muted, #a1a1a6); line-height: 1.45; }
.tag { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; background: var(--kw-accent, #ffbf23); color: var(--kw-accent-ink, #1d1d1f); }
.toast { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; box-sizing: border-box; width: min(460px, calc(100vw - 32px)); display: flex; gap: 14px; align-items: center; padding: 14px 14px 14px 16px; background: var(--kw-surface, #1b1b1e); border: 1px solid var(--kw-line, #34343a); border-radius: var(--kw-radius, 16px); box-shadow: 0 16px 40px rgba(0,0,0,.45); }
.toast p { flex: 1; margin: 0; font-size: 13.5px; }
.toast strong { display: block; color: var(--kw-text, #f5f5f7); font-size: 14.5px; margin-bottom: 2px; }
.toast .actions { display: flex; gap: 6px; flex: none; }
.toast button { width: auto; min-height: 38px; padding: 0 14px; font-size: 14px; }
.chip { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 10px; padding: 6px 14px 6px 6px; cursor: pointer; border-radius: 999px; background: var(--kw-surface, #1b1b1e); border: 1px solid var(--kw-line, #34343a); }
.avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; overflow: hidden; background: var(--kw-raised, #26262b); font-weight: 700; font-size: 14px; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.who { display: grid; line-height: 1.2; }
.who b { font-size: 14px; }
.who small { color: var(--kw-muted, #a1a1a6); font-size: 11.5px; }
.menu { position: absolute; z-index: 2147483001; min-width: 200px; margin-top: 6px; padding: 6px; display: grid; background: var(--kw-surface, #1b1b1e); border: 1px solid var(--kw-line, #34343a); border-radius: var(--kw-radius-sm, 10px); box-shadow: 0 12px 32px rgba(0,0,0,.4); }
.menu button { justify-content: flex-start; min-height: 40px; background: transparent; color: var(--kw-text, #f5f5f7); font-weight: 500; }
.menu button:hover { background: var(--kw-raised, #26262b); }
.wrap { position: relative; display: inline-block; }
.signin { width: auto; padding: 0 18px 0 12px; }
.mark { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; font-weight: 800; font-size: 13px; background: var(--kw-accent-ink, #1d1d1f); color: var(--kw-accent, #ffbf23); }
`;

type Make = <K extends keyof HTMLElementTagNameMap>(tag: K, props?: Partial<HTMLElementTagNameMap[K]> & { className?: string }, ...children: Array<Node | string | null>) => HTMLElementTagNameMap[K];

const el: Make = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null) node.append(child);
  return node;
};

/** A shadow root on `document.body` holding one screen at a time, styled by `UI_CSS`. */
function layer(): { root: ShadowRoot; remove(): void } {
  const host = document.createElement('krtuworks-layer');
  const root = host.attachShadow({ mode: 'open' });
  root.append(el('style', { textContent: UI_CSS }));
  document.body.append(host);
  return { root, remove: () => host.remove() };
}

function sentence(texts: UiTexts, key: UiTextKey, links: Record<string, { href: string; text: string }>): Node[] {
  return textSegments(texts, key).map((part) =>
    typeof part === 'string' ? document.createTextNode(part) : links[part.mark] ? el('a', { href: links[part.mark].href, target: '_blank', rel: 'noopener', textContent: links[part.mark].text }) : document.createTextNode(`{${part.mark}}`),
  );
}

function saveCard(card: SaveCard, texts: UiTexts): HTMLButtonElement {
  const name = el('div', { className: 'save-name', textContent: card.label }, card.newer ? el('span', { className: 'tag', textContent: textFor(texts, 'conflict.newer') }) : null);
  const lines = [...(card.summary?.title ? [card.summary.title] : []), ...(card.summary?.lines ?? []), card.when, card.size].filter(Boolean);
  const meta = el('div', { className: 'meta' });
  lines.forEach((line, i) => meta.append(...(i ? [el('br'), line] : [line])));
  return el('button', { className: 'save', type: 'button' }, card.summary?.image ? el('img', { src: card.summary.image, alt: '' }) : null, name, meta);
}

function draw(screen: UiScreen, texts: UiTexts, answer: (a: UiAnswer) => void): HTMLElement {
  const t = (key: UiTextKey, vars?: Record<string, string>) => textFor(texts, key, vars);
  const legal = (termsUrl: string, privacyUrl: string) => ({ terms: { href: termsUrl, text: t('age.termsLink') }, privacy: { href: privacyUrl, text: t('age.privacyLink') } });
  const card = (wide = false) => el('div', { className: wide ? 'card wide' : 'card' });
  switch (screen.kind) {
    case 'age': {
      const box = card();
      const day = el('select', { name: 'day' }, el('option', { value: '', textContent: '' }));
      for (let d = 1; d <= 31; d += 1) day.append(el('option', { value: String(d), textContent: String(d) }));
      const month = el('select', { name: 'month' }, el('option', { value: '', textContent: '' }));
      for (let m = 1; m <= 12; m += 1) month.append(el('option', { value: String(m), textContent: t(`month.${m}` as UiTextKey) }));
      const year = el('select', { name: 'year' }, el('option', { value: '', textContent: '' }));
      for (const y of screen.years) year.append(el('option', { value: String(y), textContent: String(y) }));
      const trimDays = () => {
        const max = year.value && month.value ? daysInMonth(Number(year.value), Number(month.value)) : 31;
        for (const option of Array.from(day.options)) option.disabled = Number(option.value) > max;
        if (Number(day.value) > max) day.value = '';
      };
      year.addEventListener('change', trimDays);
      month.addEventListener('change', trimDays);
      const field = (key: UiTextKey, select: HTMLSelectElement) => el('label', {}, el('span', { className: 'field-name', textContent: t(key) }), select);
      const fields = { d: field('age.day', day), m: field('age.month', month), y: field('age.year', year) };
      const row = el('div', { className: 'row' }, ...screen.order.split('').map((k) => fields[k as 'd' | 'm' | 'y']));
      const accept = el('input', { type: 'checkbox' });
      const check = el('label', { className: 'check' }, accept, el('span', {}, ...sentence(texts, 'age.accept', legal(screen.termsUrl, screen.privacyUrl))));
      const problem = screen.problem ? el('div', { className: 'problem', role: 'alert', textContent: t(screen.problem === 'invalid' ? 'age.invalid' : 'age.acceptNeeded') }) : null;
      const go = el('button', { type: 'button', textContent: t('age.continue') });
      go.addEventListener('click', () => answer({ kind: 'birth', year: Number(year.value), month: Number(month.value), day: Number(day.value), accepted: accept.checked }));
      const actions = el('div', { className: 'stack' }, go);
      if (screen.signIn) {
        const signIn = el('button', { type: 'button', className: 'ghost', textContent: t('age.signIn') });
        signIn.addEventListener('click', () => answer({ kind: 'signIn' }));
        actions.append(signIn);
      }
      box.append(el('h2', { textContent: t('age.title') }), problem ?? '', row, check, actions);
      return box;
    }
    case 'terms': {
      const go = el('button', { type: 'button', textContent: t('terms.accept') });
      go.addEventListener('click', () => answer({ kind: 'accept' }));
      const box = card();
      box.append(el('h2', { textContent: t('terms.title') }), el('p', {}, ...sentence(texts, 'terms.body', legal(screen.termsUrl, screen.privacyUrl))), go);
      return box;
    }
    case 'underage': {
      const go = el('button', { type: 'button', textContent: t('underage.play') });
      go.addEventListener('click', () => answer({ kind: 'offline' }));
      const box = card();
      box.append(el('h2', { textContent: t('underage.title') }), el('p', { textContent: t('underage.body') }), go);
      return box;
    }
    case 'conflict': {
      let picked: 0 | 1 = screen.cards[0].newer ? 0 : 1;
      const cards = screen.cards.map((c) => saveCard(c, texts));
      const mark = () => cards.forEach((c, i) => c.setAttribute('aria-pressed', String(i === picked)));
      cards.forEach((c, i) =>
        c.addEventListener('click', () => {
          picked = i as 0 | 1;
          mark();
        }),
      );
      mark();
      const keep = el('button', { type: 'button', textContent: t('conflict.keep') });
      keep.addEventListener('click', () => answer({ kind: 'keep', card: picked }));
      const box = card(true);
      box.append(el('h2', { textContent: t('conflict.title', { slot: screen.slot }) }), el('p', { textContent: t('conflict.body') }), el('div', { className: 'saves' }, ...cards), keep);
      return box;
    }
    case 'error': {
      const actions = el('div', { className: 'stack' });
      if (screen.retry) {
        const retry = el('button', { type: 'button', textContent: t('error.retry') });
        retry.addEventListener('click', () => answer({ kind: 'retry' }));
        actions.append(retry);
      }
      const keepPlaying = el('button', { type: 'button', className: screen.retry ? 'ghost' : '', textContent: t('error.continue') });
      keepPlaying.addEventListener('click', () => answer({ kind: 'continue' }));
      actions.append(keepPlaying);
      const box = card();
      box.append(el('h2', { textContent: t('error.title') }), el('div', { className: 'problem', role: 'alert', textContent: screen.message }), actions);
      return box;
    }
  }
}

/** The page's elements for the screens: one modal at a time, focus inside it while it is open. */
export function domHost(options: { texts?: UiTexts } = {}): UiHost {
  const texts = options.texts ?? {};
  return {
    show(screen: UiScreen): UiDialog {
      const { root, remove } = layer();
      const before = document.activeElement as HTMLElement | null;
      let settle: (a: UiAnswer) => void = () => undefined;
      const answer = new Promise<UiAnswer>((resolve) => (settle = resolve));
      const box = draw(screen, texts, (a) => settle(a));
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const shell = el('div', { className: 'kw backdrop' }, box);
      shell.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        const focusable = Array.from(box.querySelectorAll<HTMLElement>('button, select, input, a'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && root.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && root.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      });
      root.append(shell);
      box.querySelector<HTMLElement>('select, button')?.focus();
      return {
        answer,
        close() {
          remove();
          before?.focus?.();
        },
      };
    },
    remind() {
      const { root, remove } = layer();
      const t = (key: UiTextKey) => textFor(texts, key);
      let settle: (a: 'link' | 'later') => void = () => undefined;
      const answer = new Promise<'link' | 'later'>((resolve) => (settle = resolve));
      const later = el('button', { type: 'button', className: 'ghost', textContent: t('reminder.later') });
      const link = el('button', { type: 'button', textContent: t('reminder.link') });
      later.addEventListener('click', () => settle('later'));
      link.addEventListener('click', () => settle('link'));
      const timer = setTimeout(() => settle('later'), 20_000);
      root.append(el('div', { className: 'kw toast', role: 'status' }, el('p', {}, el('strong', { textContent: t('reminder.title') }), t('reminder.body')), el('div', { className: 'actions' }, later, link)));
      void answer.then(() => {
        clearTimeout(timer);
        remove();
      });
      return { answer, close: () => settle('later') };
    },
  };
}

/** Remembers the components' small values in the page's storage (nothing when the browser refuses it). */
export function pageMemory(): UiMemory {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      } catch {
        // Storage refused: the value lasts for this page only.
      }
    },
  };
}

let defined: KrtuworksUi | null = null;

/** `<krtuworks-sign-in>` and `<krtuworks-account>` for the page, bound to `ui`. */
export function defineElements(ui: KrtuworksUi): void {
  defined = ui;
  if (customElements.get('krtuworks-sign-in')) return;

  class SignInButton extends HTMLElement {
    connectedCallback(): void {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: 'open' });
      const button = el('button', { type: 'button', className: 'signin' }, el('span', { className: 'mark', textContent: 'K' }), defined ? defined.t('signIn.button') : '');
      button.addEventListener('click', () => void defined?.signIn());
      root.append(el('style', { textContent: UI_CSS }), el('div', { className: 'kw' }, button));
    }
  }

  class AccountChip extends HTMLElement {
    private stop: (() => void) | null = null;

    connectedCallback(): void {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this.render();
      this.stop = defined?.client.onIdentityChange(() => this.render()) ?? null;
    }

    disconnectedCallback(): void {
      this.stop?.();
      this.stop = null;
    }

    private render(): void {
      const ui = defined;
      const root = this.shadowRoot as ShadowRoot;
      root.replaceChildren(el('style', { textContent: UI_CSS }));
      if (!ui) return;
      const player: Player | null = ui.client.player;
      if (!player) return;
      const guest = player.kind === 'guest';
      const name = guest ? ui.t('account.guest') : (player.username ?? ui.t('account.label'));
      const avatar = el('span', { className: 'avatar' }, player.picture ? el('img', { src: player.picture, alt: '' }) : name.slice(0, 1).toUpperCase());
      const chip = el('button', { type: 'button', className: 'chip' }, avatar, el('span', { className: 'who' }, el('b', { textContent: name }), el('small', { textContent: ui.t('account.label') })));
      chip.setAttribute('aria-haspopup', 'menu');
      const wrap = el('div', { className: 'kw wrap' }, chip);
      const item = (key: UiTextKey, run: () => void) => {
        const button = el('button', { type: 'button', textContent: ui.t(key) });
        button.setAttribute('role', 'menuitem');
        button.addEventListener('click', () => {
          menu?.remove();
          menu = null;
          run();
        });
        return button;
      };
      let menu: HTMLElement | null = null;
      chip.addEventListener('click', () => {
        if (menu) {
          menu.remove();
          menu = null;
          return;
        }
        menu = el('div', { className: 'menu' }, guest ? item('account.link', () => void ui.signIn()) : item('account.manage', () => window.open(ACCOUNT_URL, '_blank', 'noopener')), guest ? null : item('account.signOut', () => void ui.signOut()));
        menu.setAttribute('role', 'menu');
        wrap.append(menu);
      });
      root.append(wrap);
    }
  }

  customElements.define('krtuworks-sign-in', SignInButton);
  customElements.define('krtuworks-account', AccountChip);
}
