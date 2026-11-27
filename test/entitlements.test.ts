import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Krtuworks } from '../src/client.js';
import { memoryStore } from '../src/store.js';
import { APP, FakeServer, guestRoutes, options } from './fakeServer.js';

type Item = { sku: string; source: string; status: 'ACTIVE' | 'REVOKED' | null; checked: boolean; platformProductId: string | null };
const item = (sku: string, status: Item['status'], checked = false, id: string | null = null): Item => ({ sku, source: 'STEAM', status, checked, platformProductId: id });

interface Fake {
  /** What GET /v1/me/entitlements answers. */
  stored: Item[];
  /** What a session open answers (entitlements); omitted when null. */
  session: Item[] | null;
}

function setup(fake: Fake, type?: 'GAME' | 'WEB_APP') {
  const server = new FakeServer();
  guestRoutes(server);
  server.on('GET', '/v1/apps/buried/config', () => ({
    json: { appId: 'app_x', environment: 'TEST', platform: 'STEAM', version: '1.0', config: {}, switches: [], serverTime: new Date().toISOString() },
  }));
  server.on('GET', '/v1/me/entitlements', () => ({ json: { entitlements: fake.stored, serverTime: new Date().toISOString() } }));
  server.on('POST', '/v1/sessions', () => ({
    status: 201,
    json: { session: { id: 'ses_1', startedAt: new Date().toISOString() }, heartbeatSeconds: 60, serverTime: new Date().toISOString(), ...(fake.session ? { entitlements: fake.session } : {}) },
  }));
  const store = memoryStore();
  const open = async (extra: Record<string, unknown> = {}) => {
    const krtu = await Krtuworks.initialize({
      ...options(server, { store, platform: 'STEAM' }),
      ...(type ? { config: { ...APP, type } } : {}),
      ...extra,
    });
    if (!krtu.player) await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
    await krtu.ready();
    return krtu;
  };
  return { server, store, open };
}

const LICENCES: Item[] = [item('base', 'ACTIVE', false, '480'), item('season-pass', 'REVOKED', false, '482'), item('soundtrack', 'ACTIVE', false, '481')];

test('a Steam launch fetches the stored licences: ownsDlc is true for an ACTIVE DLC, false for a REVOKED, an unlisted or an unknown one', async () => {
  const { open, server } = setup({ stored: LICENCES, session: null });
  const krtu = await open();
  assert.equal(server.count('GET', '/v1/me/entitlements'), 1);
  assert.equal(krtu.ownsDlc('soundtrack'), true);
  assert.equal(krtu.ownsDlc('season-pass'), false);
  assert.equal(krtu.ownsDlc('never-heard-of'), false);
  assert.deepEqual(krtu.entitlements().map((e) => [e.sku, e.status, e.checked]), [['base', 'ACTIVE', false], ['season-pass', 'REVOKED', false], ['soundtrack', 'ACTIVE', false]]);
  await krtu.shutdown();
});

test('the last answer stays on the device: a launch that cannot reach the server still knows what the player owned', async () => {
  const { open, server } = setup({ stored: LICENCES, session: null });
  const first = await open();
  await first.shutdown();
  server.offline.add('/v1/me/entitlements');
  const second = await open();
  assert.equal(second.ownsDlc('soundtrack'), true, 'kept from the earlier launch');
  assert.equal(second.ownsDlc('season-pass'), false);
  assert.equal(second.entitlements().length, 3);
  await second.shutdown();
});

test("the session answer's confirmed item beats what was kept; an unconfirmed one does not (control)", async () => {
  const fake: Fake = { stored: LICENCES, session: [item('base', 'ACTIVE', true, '480'), item('season-pass', 'ACTIVE', true, '482'), item('soundtrack', 'REVOKED', true, '481')] };
  const { open, server } = setup(fake);
  server.offline.add('/v1/me/entitlements');
  const krtu = await open({ sessions: true });
  assert.equal(krtu.ownsDlc('soundtrack'), false, 'Steam confirmed the refund this launch');
  assert.equal(krtu.ownsDlc('season-pass'), true, 'Steam confirmed the purchase this launch');
  assert.equal(krtu.entitlements().find((e) => e.sku === 'soundtrack')?.checked, true);
  await krtu.shutdown();

  // The next launch's session could not check (Steam away): the answer carries the stored state with checked false, which is the last answer, not a confirmation.
  fake.session = [item('base', 'ACTIVE', false, '480'), item('season-pass', 'ACTIVE', false, '482'), item('soundtrack', 'REVOKED', false, '481')];
  const again = await open({ sessions: true });
  assert.equal(again.ownsDlc('soundtrack'), false);
  assert.equal(again.ownsDlc('season-pass'), true);
  assert.equal(again.entitlements().some((e) => e.checked), false);
  await again.shutdown();
});

test("a DLC the player never owned is listed by the session with its platform id (for the platform's own check) and is not owned", async () => {
  const { open } = setup({ stored: [], session: [item('base', 'ACTIVE', true, '480'), item('skins', null, true, '483')] });
  const krtu = await open({ sessions: true });
  assert.equal(krtu.ownsDlc('skins'), false);
  assert.deepEqual(krtu.entitlements().find((e) => e.sku === 'skins'), item('skins', null, true, '483'));
  await krtu.shutdown();
});

test('refreshEntitlements fetches again and keeps the answer; a DLC the server no longer lists becomes unowned', async () => {
  const fake: Fake = { stored: LICENCES, session: null };
  const { open } = setup(fake);
  const krtu = await open();
  assert.equal(krtu.ownsDlc('soundtrack'), true);
  fake.stored = [item('base', 'ACTIVE', false, '480')];
  const list = await krtu.refreshEntitlements();
  assert.equal(krtu.ownsDlc('soundtrack'), false);
  assert.deepEqual(list.find((e) => e.sku === 'soundtrack'), item('soundtrack', null, false, '481'));
  await krtu.shutdown();
});

test('only a Steam game fetches on its own; another platform does it on request (control), an app that is not a game owns nothing and asks nothing', async () => {
  const web = setup({ stored: LICENCES, session: null });
  const onWeb = await web.open({ platform: 'WEB' });
  assert.equal(web.server.count('GET', '/v1/me/entitlements'), 0);
  assert.equal(onWeb.ownsDlc('soundtrack'), false);
  await onWeb.refreshEntitlements();
  assert.equal(web.server.count('GET', '/v1/me/entitlements'), 1);
  assert.equal(onWeb.ownsDlc('soundtrack'), true);
  await onWeb.shutdown();

  const app = setup({ stored: LICENCES, session: null }, 'WEB_APP');
  const notGame = await app.open();
  assert.equal(app.server.count('GET', '/v1/me/entitlements'), 0);
  assert.equal(notGame.ownsDlc('soundtrack'), false);
  assert.deepEqual(notGame.entitlements(), []);
  assert.deepEqual(await notGame.refreshEntitlements(), []);
  assert.equal(app.server.count('GET', '/v1/me/entitlements'), 0);
  await notGame.shutdown();
});

test("a session answer for one player never lands in the next player's licences, while the kept list is still being read", async () => {
  const { Entitlements } = await import('../src/entitlements.js');
  let subject = 'pw_a';
  let release: () => void = () => {};
  const slowA = new Promise<void>((resolve) => (release = resolve));
  const kept = new Map<string, unknown>();
  const store = {
    get: async <T>(key: string): Promise<T | null> => {
      if (key.endsWith(':pw_a')) await slowA;
      return (kept.get(key) as T) ?? null;
    },
    set: async (key: string, value: unknown) => void kept.set(key, value),
    delete: async (key: string) => void kept.delete(key),
  };
  const answers: Record<string, Item[]> = { pw_a: [item('expansion', 'ACTIVE', true)], pw_b: [] };
  const api = { player: async (_path: string, call: { owner?: string } = {}) => ({ json: { entitlements: answers[call.owner ?? subject] } }) };
  const licences = new Entitlements('c', store as never, api as never, () => subject);

  const forA = licences.fromSession(answers.pw_a);
  subject = 'pw_b';
  await licences.refresh();
  release();
  await forA;
  assert.equal(licences.ownsDlc('expansion'), false, "A's confirmed DLC is not B's");
  assert.deepEqual(licences.list(), []);
  assert.equal(kept.has('krtu:c:entitlements:pw_b') && (kept.get('krtu:c:entitlements:pw_b') as unknown[]).length, 0);

  // Control: B's own session answer is taken.
  await licences.fromSession([item('expansion', 'ACTIVE', true)]);
  assert.equal(licences.ownsDlc('expansion'), true);
});

test("a refresh answered after the player changed is dropped, and its call was made for the player who asked", async () => {
  const { Entitlements } = await import('../src/entitlements.js');
  let subject = 'pw_a';
  let answer: (v: unknown) => void = () => {};
  const owners: (string | undefined)[] = [];
  const kept = new Map<string, unknown>();
  const store = {
    get: async <T>(key: string): Promise<T | null> => (kept.get(key) as T) ?? null,
    set: async (key: string, value: unknown) => void kept.set(key, value),
    delete: async (key: string) => void kept.delete(key),
  };
  const api = {
    player: (_path: string, call: { owner?: string } = {}) => {
      owners.push(call.owner);
      return call.owner === 'pw_a' ? new Promise((resolve) => (answer = resolve)) : Promise.resolve({ json: { entitlements: [] } });
    },
  };
  const licences = new Entitlements('c', store as never, api as never, () => subject);
  const forA = licences.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  subject = 'pw_b';
  await licences.ensureLoaded();
  answer({ json: { entitlements: [item('expansion', 'ACTIVE')] } });
  assert.deepEqual(await forA, []);
  assert.equal(licences.ownsDlc('expansion'), false);
  assert.equal(kept.get('krtu:c:entitlements:pw_b'), undefined, "nothing of A's answer is written as B's");
  assert.deepEqual(owners, ['pw_a']);
});
