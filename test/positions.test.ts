import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Krtuworks } from '../src/client.js';
import { resolveOptions } from '../src/config.js';
import { PositionSampler } from '../src/positions.js';
import { FakeServer, guestRoutes, options } from './fakeServer.js';

test('a sampler tells one sample per interval with the seconds since the one before (control: reports inside the interval tell nothing)', () => {
  const s = new PositionSampler(10);
  assert.equal(s.due(100), null, 'the first report only starts the clock');
  assert.equal(s.due(104), null);
  assert.equal(s.due(109.9), null);
  assert.equal(s.due(110), 10);
  assert.equal(s.due(111), null);
  assert.equal(s.due(122.4), 12, 'a late frame carries the whole time since the last sample');
});

test('time the game did not report belongs to no position (control: a gap within three intervals is told)', () => {
  const s = new PositionSampler(10);
  s.due(0);
  assert.equal(s.due(31), null, 'over three intervals: the clock starts again');
  assert.equal(s.due(41), 10);
  assert.equal(s.due(70), 29);
  s.reset();
  assert.equal(s.due(200), null, 'after a reset the next report starts the clock');
  assert.equal(s.due(150), null, 'a clock that went back starts again');
  assert.equal(s.due(160), 10);
});

test('the interval is whole seconds, 1-600, 10 by default', () => {
  const base = options(new FakeServer());
  assert.equal(resolveOptions(base).positionSampleSeconds, 10);
  assert.equal(resolveOptions({ ...base, positionSampleSeconds: 600 }).positionSampleSeconds, 600);
  for (const bad of [0, 601, 2.5]) assert.throws(() => resolveOptions({ ...base, positionSampleSeconds: bad }), TypeError);
});

function routes(server: FakeServer, modules: Record<string, boolean>, sent: any[]) {
  guestRoutes(server);
  server.on('GET', '/v1/apps/buried/config', () => ({ json: { appId: 'app_x', environment: 'TEST', platform: 'WEB', version: '1.0', config: { modules }, switches: [], serverTime: new Date().toISOString() } }));
  server.on('POST', '/v1/events', (call) => {
    const body = JSON.parse(new TextDecoder().decode(call.raw));
    sent.push(...body.events);
    return { json: { batchId: body.batchId, accepted: body.events.map((e: { id: string }) => e.id), duplicate: [], rejected: [], retry: [], telemetry: true } };
  });
  server.on('GET', '/v1/me/telemetry-opt-out', () => ({ json: { optedOut: false, updatedAt: null } }));
}

test('a game sends a position sample with its seconds and place under the positions module (control: positions off, or an app, sends none)', async () => {
  let now = 0;
  mock.method(performance, 'now', () => now);
  try {
    const at = { space: 'world' as const, area: 'Forest', x: 12.5, y: 40, z: 1 };
    for (const [name, modules, type, kept] of [
      ['game', { customEvents: false }, undefined, true],
      ['positions off', { positions: false, combat: true }, undefined, false],
      ['an app', {}, 'MOBILE_APP', false],
    ] as const) {
      const server = new FakeServer();
      const sent: any[] = [];
      routes(server, modules, sent);
      const base = options(server);
      const krtu = await Krtuworks.initialize({ ...base, config: { ...base.config, ...(type ? { type } : {}) } });
      await krtu.refreshConfig();
      await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
      await krtu.ready();
      assert.equal(krtu.samplePosition(at), false, `${name}: the first report starts the clock`);
      now += 4_000;
      assert.equal(krtu.samplePosition(at), false, `${name}: inside the interval`);
      now += 7_000;
      assert.equal(krtu.samplePosition(at), kept, name);
      await krtu.flush();
      const samples = sent.filter((e) => e.type === 'position_sample');
      if (kept) {
        assert.equal(samples.length, 1);
        assert.deepEqual(samples[0].position, at);
        assert.deepEqual(samples[0].data, { seconds: 11 });
      } else {
        assert.equal(samples.length, 0, name);
      }
      await krtu.shutdown();
    }
  } finally {
    mock.restoreAll();
  }
});

test('a position without an area, or with a number that is not finite, is refused', async () => {
  const server = new FakeServer();
  routes(server, {}, []);
  const krtu = await Krtuworks.initialize(options(server));
  assert.throws(() => krtu.samplePosition({ space: 'world', area: '', x: 1, y: 1 }), TypeError);
  assert.throws(() => krtu.samplePosition({ space: 'world', area: 'Forest', x: Number.NaN, y: 1 }), TypeError);
  assert.throws(() => krtu.samplePosition({ space: 'map' as 'world', area: 'Forest', x: 1, y: 1 }), TypeError);
  assert.equal(krtu.samplePosition({ space: 'screen', area: 'Menu', x: 1, y: 1 }), false);
  await krtu.shutdown();
});
