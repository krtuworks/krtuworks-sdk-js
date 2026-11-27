import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../src/api.js';
import { Clock } from '../src/clock.js';
import { cleanDevice, resolveOptions } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { ProgressQueue } from '../src/progress.js';
import { memoryStore } from '../src/store.js';
import { FakeServer, guestRoutes, options } from './fakeServer.js';

test("the device is sent as the server takes it: text trimmed and cut to its limits, empty parts and numbers out of range dropped (control: a device that fits is sent as it is)", () => {
  const fits = { os: 'Windows', osVersion: '11', model: 'Desktop', gpu: 'RTX', ramMb: 16384, screenWidth: 1920, screenHeight: 1080 };
  assert.deepEqual(cleanDevice(fits), fits);
  const cleaned = cleanDevice({ os: ' ' + 'o'.repeat(60), osVersion: '', model: 'm'.repeat(200), gpu: 'g'.repeat(130), ramMb: 0, screenWidth: 200_000, screenHeight: 1.5 });
  assert.equal(cleaned.os, 'o'.repeat(40));
  assert.equal(cleaned.osVersion, undefined);
  assert.equal(cleaned.model, 'm'.repeat(80), 'the server takes 80');
  assert.equal(cleaned.gpu, 'g'.repeat(120));
  assert.deepEqual([cleaned.ramMb, cleaned.screenWidth, cleaned.screenHeight], [undefined, undefined, undefined]);
  // A pair is never cut in half.
  assert.equal(cleanDevice({ model: 'x'.repeat(79) + '\u{1F3AE}' }).model, 'x'.repeat(79));
  const resolved = resolveOptions({ ...options(new FakeServer()), device: { model: 'm'.repeat(200) }, locale: 'l'.repeat(50) });
  assert.equal(resolved.device?.model?.length, 80);
  assert.equal(resolved.locale?.length, 35);
});

test('a stat reported while the kinds load stays with the player who reported it, not the one who arrived meanwhile', async () => {
  const server = new FakeServer();
  guestRoutes(server, 'pw_guest_aaaaaaaaaaaa');
  const inner = memoryStore();
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  let gated = true;
  const store = {
    ...inner,
    async get<T>(key: string) {
      if (gated && key.endsWith(':statKinds')) await open;
      return inner.get<T>(key);
    },
  };
  const opts = resolveOptions({ ...options(server), store, fetch: server.fetch });
  const clock = new Clock();
  const identity = new Identity({ opts, store, fetch: server.fetch, clock });
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const api = new Api(opts, identity, server.fetch, clock);
  let player: string | null = 'pw_first_aaaaaaaaaaaa';
  const progress = new ProgressQueue({ opts, store, api, subject: () => player });
  const reporting = progress.report('add', 'kills', 3);
  player = 'pw_second_bbbbbbbbbbbb';
  gated = false;
  release();
  await reporting;
  assert.equal(await progress.waiting('pw_first_aaaaaaaaaaaa'), 1, 'it waits for the first player');
  assert.equal(await progress.waiting('pw_second_bbbbbbbbbbbb'), 0, 'control: the second player has nothing');
});
