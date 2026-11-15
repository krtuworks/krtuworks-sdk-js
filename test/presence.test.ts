import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Krtuworks } from '../src/client.js';
import { isKrtuworksError } from '../src/errors.js';
import { memoryStore } from '../src/store.js';
import { APP, FakeServer, guestRoutes, options, presenceRoutes, type PresenceFake } from './fakeServer.js';

const STATES = [
  { key: 'menu', token: '#Menu', params: [] },
  { key: 'playing', token: '#Playing', params: ['LEVEL', 'MODE'] },
  { key: 'timed', token: '#Timed', params: ['SESSION_MINUTES'] },
];

function setup(config: Record<string, unknown> = {}, type?: 'GAME' | 'WEB_APP') {
  const server = new FakeServer();
  guestRoutes(server);
  server.on('GET', '/v1/apps/buried/config', () => ({
    json: { appId: 'app_x', environment: 'TEST', platform: 'WEB', version: '1.0', config, switches: [], serverTime: new Date().toISOString() },
  }));
  const fake: PresenceFake = { states: STATES, visible: true, on: true };
  presenceRoutes(server, fake);
  const store = memoryStore();
  const open = async (extra: Record<string, unknown> = {}) => {
    const krtu = await Krtuworks.initialize({ ...options(server, { store }), ...(type ? { config: { ...APP, type } } : {}), ...extra });
    if (!krtu.player) await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
    await krtu.ready();
    return krtu;
  };
  return { server, fake, store, open };
}

test('an undeclared state is unknown_state (control: a declared one passes every rule and ends at no_platform)', async () => {
  const { open } = setup();
  const krtu = await open();
  assert.deepEqual(await krtu.setPresence('nope'), { applied: false, reason: 'unknown_state' });
  assert.deepEqual(await krtu.setPresence('menu'), { applied: false, reason: 'no_platform' });
  await krtu.shutdown();
});

test('a declared param without a value is param_missing (control: with it, or filled by a built-in, the call reaches no_platform)', async () => {
  const { open } = setup();
  const krtu = await open();
  assert.deepEqual(await krtu.setPresence('playing', { MODE: 'solo' }), { applied: false, reason: 'param_missing' }, 'LEVEL is built-in but no level is open');
  assert.deepEqual(await krtu.setPresence('playing', { MODE: '', LEVEL: 3 }), { applied: false, reason: 'param_missing' }, 'an empty value is no value');
  assert.deepEqual(await krtu.setPresence('playing', { MODE: 'solo', LEVEL: 3, EXTRA: 'x' }), { applied: false, reason: 'no_platform' });
  await krtu.level.start({ level: 'cave' });
  assert.deepEqual(await krtu.setPresence('playing', { MODE: 'solo' }), { applied: false, reason: 'no_platform' }, 'LEVEL came from the open attempt');
  assert.deepEqual(await krtu.setPresence('timed'), { applied: false, reason: 'no_platform' }, 'SESSION_MINUTES is always known');
  await krtu.shutdown();
});

test('the choice round trips, persists across launches and false makes the next call hidden (control: true lets it through)', async () => {
  const { open, fake } = setup();
  const krtu = await open();
  assert.equal(krtu.presenceVisible(), true);
  await krtu.setPresenceVisible(false);
  assert.equal(fake.visible, false);
  assert.equal(krtu.presenceVisible(), false);
  assert.deepEqual(await krtu.setPresence('menu'), { applied: false, reason: 'hidden' });
  await krtu.shutdown();

  const again = await open({ fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch });
  assert.equal(again.presenceVisible(), false, 'read from the store, no server');
  assert.deepEqual(await again.setPresence('menu'), { applied: false, reason: 'hidden' });
  await again.shutdown();

  const back = await open();
  await back.setPresenceVisible(true);
  assert.equal(back.presenceVisible(), true);
  assert.deepEqual(await back.setPresence('menu'), { applied: false, reason: 'no_platform' });
  await back.shutdown();
});

test('the module off in the remote config is module_disabled, and the choice cannot be changed', async () => {
  const { open, server } = setup({ modules: { presence: false } });
  const krtu = await open();
  assert.deepEqual(await krtu.setPresence('menu'), { applied: false, reason: 'module_disabled' });
  assert.equal(krtu.presenceVisible(), null);
  await assert.rejects(krtu.setPresenceVisible(false), (err) => isKrtuworksError(err) && err.code === 'module_disabled');
  assert.equal(server.count('GET', '/v1/me/presence-states'), 0, 'nothing is asked while the module is off');
  assert.equal(server.count('PUT', '/v1/me/presence-visibility'), 0);
  await krtu.shutdown();
});

test('the states are revalidated with the ETag and a 304 keeps the kept copy (control: a changed list is taken)', async () => {
  const { open, server, fake } = setup();
  const krtu = await open();
  assert.equal(krtu.presenceVisible(), true);
  assert.equal(server.calls.find((c) => c.path === '/v1/me/presence-states')!.headers.get('if-none-match'), null);
  await krtu.refreshConfig();
  const states = server.calls.filter((c) => c.path === '/v1/me/presence-states');
  assert.equal(states.length, 2);
  assert.equal(states[1]!.headers.get('if-none-match'), '"p3"');
  assert.deepEqual(await krtu.setPresence('menu'), { applied: false, reason: 'no_platform' }, 'the 304 kept the states');

  fake.states = [...STATES, { key: 'credits', token: '#Credits', params: [] }];
  assert.deepEqual(await krtu.setPresence('credits'), { applied: false, reason: 'unknown_state' }, 'not seen yet');
  await krtu.refreshConfig();
  assert.deepEqual(await krtu.setPresence('credits'), { applied: false, reason: 'no_platform' });
  await krtu.shutdown();
});

test('before any states arrive the answer is states_unknown', async () => {
  const { open, fake } = setup();
  fake.on = false;
  const krtu = await open();
  assert.deepEqual(await krtu.setPresence('menu'), { applied: false, reason: 'states_unknown' });
  await krtu.shutdown();
});

test('an app that is not a game is not_game, whatever the module says (control: the same setup as a game reaches no_platform)', async () => {
  const app = setup({}, 'WEB_APP');
  const web = await app.open();
  assert.deepEqual(await web.setPresence('menu'), { applied: false, reason: 'not_game' });
  assert.equal(app.server.count('GET', '/v1/me/presence-states'), 0);
  await web.shutdown();
  const game = await setup({}, 'GAME').open();
  assert.deepEqual(await game.setPresence('menu'), { applied: false, reason: 'no_platform' });
  await game.shutdown();
});
