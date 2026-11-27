import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Krtuworks } from '../src/client.js';
import { FakeServer, guestRoutes, options } from './fakeServer.js';

test('the sessions switch takes effect on the next config read: on opens a session, off ends it and stops its heartbeats (control: on again opens a new one)', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  let sessionsOn = false;
  let version = 1;
  server.on('GET', '/v1/apps/buried/config', () => ({
    json: { appId: 'app_x', environment: 'TEST', platform: 'WEB', version: `${version}.0`, config: { modules: { sessions: sessionsOn } }, switches: [], serverTime: new Date().toISOString() },
    headers: { etag: `"v${version}"` },
  }));
  server.on('GET', '/v1/me/telemetry-opt-out', () => ({ json: { optedOut: false, updatedAt: null } }));
  let ids = 0;
  server.on('POST', '/v1/sessions', () => {
    ids += 1;
    return { status: 201, json: { session: { id: `ses_${String(ids).padStart(20, 'a')}`, startedAt: new Date().toISOString() }, heartbeatSeconds: 60, serverTime: new Date().toISOString() } };
  });
  const krtu = await Krtuworks.initialize(options(server, { sessions: true }));
  await krtu.refreshConfig();
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  await krtu.flush();
  assert.equal(server.count('POST', '/v1/sessions'), 0, 'off at the start: no session');

  const flip = async (on: boolean) => {
    sessionsOn = on;
    version += 1;
    await krtu.refreshConfig();
    await new Promise((r) => setTimeout(r, 30));
  };
  await flip(true);
  assert.equal(server.count('POST', '/v1/sessions'), 1, 'switched on: the session opens');

  await flip(false);
  const ends = () => server.calls.filter((c) => c.path.endsWith('/end')).length;
  assert.equal(ends(), 1, 'switched off: the session ends');
  const beats = () => server.calls.filter((c) => c.path.endsWith('/heartbeat')).length;
  const before = beats();
  await krtu.flush();
  assert.equal(beats(), before, 'no heartbeat for an ended session');
  assert.equal(server.count('POST', '/v1/sessions'), 1, 'a flush does not open one while off');

  await flip(true);
  assert.equal(server.count('POST', '/v1/sessions'), 2, 'on again: a new session');
  await krtu.shutdown();
});

test("a config read leaves a refused session open to its wait: the server's Retry-After holds (control: an open that worked is not asked again)", async () => {
  const server = new FakeServer();
  guestRoutes(server);
  let version = 1;
  server.on('GET', '/v1/apps/buried/config', () => ({
    json: { appId: 'app_x', environment: 'TEST', platform: 'WEB', version: `${version}.0`, config: { modules: { sessions: true } }, switches: [], serverTime: new Date().toISOString() },
    headers: { etag: `"v${version}"` },
  }));
  server.on('GET', '/v1/me/telemetry-opt-out', () => ({ json: { optedOut: false, updatedAt: null } }));
  let refuse = true;
  server.on('POST', '/v1/sessions', () =>
    refuse
      ? { status: 503, json: { error: { code: 'busy', message: 'Busy.' } }, headers: { 'retry-after': '600' } }
      : { status: 201, json: { session: { id: `ses_${'a'.repeat(20)}`, startedAt: new Date().toISOString() }, heartbeatSeconds: 60, serverTime: new Date().toISOString() } },
  );
  const krtu = await Krtuworks.initialize(options(server, { sessions: true }));
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  await new Promise((r) => setTimeout(r, 30));
  const refused = server.count('POST', '/v1/sessions');
  assert.ok(refused >= 1, 'the open was tried and refused');
  version += 1;
  await krtu.refreshConfig();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(server.count('POST', '/v1/sessions'), refused, 'the config read does not jump the wait');

  const keeper = (krtu as unknown as { sessions: { ensure(force: boolean): void } }).sessions;
  refuse = false;
  keeper.ensure(true);
  await new Promise((r) => setTimeout(r, 30));
  const opened = server.count('POST', '/v1/sessions');
  assert.equal(opened, refused + 1, 'its time come: it opens');
  version += 1;
  await krtu.refreshConfig();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(server.count('POST', '/v1/sessions'), opened, 'an open session is not opened again');
  await krtu.shutdown();
});
