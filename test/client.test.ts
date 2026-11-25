import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Krtuworks } from '../src/client.js';
import { isKrtuworksError } from '../src/errors.js';
import { memoryStore } from '../src/store.js';
import { FakeServer, fakeJwt, guestRoutes, options } from './fakeServer.js';

function configRoute(server: FakeServer, config: Record<string, unknown>, switches: unknown[] = [], startVersion = 1) {
  let version = startVersion;
  server.on('GET', '/v1/apps/buried/config', (call) => {
    const etag = `"v${version}"`;
    if (call.headers.get('if-none-match') === etag) return { status: 304 };
    return { json: { appId: 'app_x', environment: 'TEST', platform: 'WEB', version: `${version}.0`, config, switches, serverTime: new Date().toISOString() }, headers: { etag } };
  });
  return { bump: () => (version += 1) };
}

function acceptEvents(server: FakeServer, into: any[]) {
  server.on('POST', '/v1/events', (call) => {
    const body = JSON.parse(new TextDecoder().decode(call.raw));
    into.push(...body.events);
    return { json: { batchId: body.batchId, accepted: body.events.map((e: { id: string }) => e.id), duplicate: [], rejected: [], retry: [], telemetry: true } };
  });
  server.on('GET', '/v1/me/telemetry-opt-out', () => ({ json: { optedOut: false, updatedAt: null } }));
}

test('a module the owner switched off makes no event (control: an event of a module that is on is kept)', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  configRoute(server, { modules: { economy: false } });
  const sent: any[] = [];
  acceptEvents(server, sent);
  const krtu = await Krtuworks.initialize(options(server));
  await krtu.refreshConfig();
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  assert.equal(krtu.track('economy', { direction: 'earn', currency: 'gold', amount: 5 }), false);
  assert.equal(krtu.track('screen_view', { screen: 'shop' }), true);
  await krtu.flush();
  assert.deepEqual(sent.map((e) => e.type), ['screen_view']);
  await krtu.shutdown();
});

test("an app that is not a game keeps no levels or deaths and has no game modules (control: a config without a type is a game's and keeps them)", async () => {
  for (const type of ['MOBILE_APP', undefined] as const) {
    const server = new FakeServer();
    guestRoutes(server);
    configRoute(server, {});
    const sent: any[] = [];
    acceptEvents(server, sent);
    const base = options(server);
    const krtu = await Krtuworks.initialize({ ...base, config: { ...base.config, ...(type ? { type } : {}) } });
    await krtu.refreshConfig();
    await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
    await krtu.ready();
    await krtu.level.start({ level: '1-1' });
    const died = krtu.death('spikes');
    krtu.level.complete(10);
    krtu.track('screen_view', { screen: 'home' });
    await krtu.flush();
    const game = type === undefined;
    assert.equal(krtu.appType, type ?? 'GAME');
    assert.equal(died, game);
    assert.equal(krtu.modules().progression, game);
    assert.equal(krtu.modules().combat, game);
    assert.equal(krtu.modules().ui, true, 'the other modules stay on');
    assert.deepEqual(sent.map((e) => e.type), game ? ['progression', 'death', 'progression', 'screen_view'] : ['screen_view']);
    await krtu.shutdown();
  }
});

test("the owner's TELEMETRY switch on this build stops events; another build's switch does not", async () => {
  const server = new FakeServer();
  guestRoutes(server);
  configRoute(server, {}, [{ build: '9.9.9', mode: 'TELEMETRY', message: 'x' }]);
  const krtu = await Krtuworks.initialize(options(server));
  await krtu.refreshConfig();
  assert.equal(krtu.track('button', { name: 'a' }), true, 'another build is switched off, not this one');
  configRoute(server, {}, [{ build: '1.0.0', mode: 'ALL', message: 'This build is off' }], 2);
  await krtu.refreshConfig();
  assert.equal(krtu.track('button', { name: 'b' }), false);
  assert.deepEqual(krtu.gate().switchedOff, { build: '1.0.0', mode: 'ALL', message: 'This build is off' });
  await krtu.shutdown();
});

test('remote config is revalidated with its ETag; maintenance and minimum version gate the build', async () => {
  const server = new FakeServer();
  configRoute(server, { maintenance: { enabled: true, message: 'Back soon' }, minVersion: '1.2', speed: 3 });
  const krtu = await Krtuworks.initialize(options(server, { build: '1.1.9+40' }));
  await krtu.refreshConfig();
  await krtu.refreshConfig();
  const asks = server.calls.filter((c) => c.path === '/v1/apps/buried/config');
  assert.equal(asks[asks.length - 1]!.headers.get('if-none-match'), '"v1"');
  assert.deepEqual(krtu.gate(), { maintenance: { enabled: true, message: 'Back soon' }, updateRequired: true, switchedOff: null });
  assert.equal(krtu.value('speed'), 3);
  assert.equal(krtu.value('missing', 'fallback'), 'fallback');
  await krtu.shutdown();
  const newer = await Krtuworks.initialize(options(server, { build: '1.2.0' }));
  await newer.refreshConfig();
  assert.equal(newer.gate().updateRequired, false, 'control: a build at the minimum plays');
  await newer.shutdown();
});

test('a player who turned statistics off makes no events; progress still goes', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  configRoute(server, {});
  const sent: any[] = [];
  acceptEvents(server, sent);
  server.on('GET', '/v1/me/telemetry-opt-out', () => ({ json: { optedOut: true, updatedAt: new Date().toISOString() } }));
  const ops: any[] = [];
  server.on('POST', '/v1/me/progress', (call) => {
    ops.push(...call.json.ops);
    return { json: { results: call.json.ops.map((o: any) => ({ opId: o.opId, status: 'applied', type: o.type, key: o.key, value: o.value })) } };
  });
  const krtu = await Krtuworks.initialize(options(server));
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  assert.equal(krtu.track('button', { name: 'x' }), false);
  await krtu.incrementStat('coins', 4);
  await krtu.flush();
  assert.equal(sent.length, 0);
  assert.deepEqual(ops.map((o) => `${o.key}:${o.value}`), ['coins:4']);
  await krtu.shutdown();
});

test('the session opens once per player and its id rides on the events', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  configRoute(server, {});
  const sent: any[] = [];
  acceptEvents(server, sent);
  server.on('POST', '/v1/sessions', (call) => ({
    status: 201,
    json: { session: { id: 'ses_aaaaaaaaaaaaaaaaaaaa', startedAt: new Date().toISOString() }, heartbeatSeconds: 60, serverTime: new Date().toISOString(), echo: call.json },
  }));
  const krtu = await Krtuworks.initialize(options(server, { sessions: true, device: { os: 'Linux', screenWidth: 1920, screenHeight: 1080 } }));
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  krtu.track('screen_view', { screen: 'menu' });
  await krtu.flush();
  const open = server.calls.find((c) => c.path === '/v1/sessions')!;
  assert.equal(open.json.platform, 'WEB');
  assert.equal(open.json.build, '1.0.0');
  assert.equal(open.json.device.os, 'Linux');
  assert.equal(open.headers.get('x-krtu-build'), '1.0.0');
  assert.equal(sent[0].sessionId, 'ses_aaaaaaaaaaaaaaaaaaaa');
  assert.equal(server.count('POST', '/v1/sessions'), 1);
  await krtu.shutdown();
  assert.equal(server.count('POST', '/v1/sessions/ses_aaaaaaaaaaaaaaaaaaaa/end'), 1);
});

test("a merged account's waiting queue moves only when the server confirms the merge", async () => {
  const server = new FakeServer();
  guestRoutes(server, 'pw_target_aaaaaaaaaa');
  configRoute(server, {});
  const sent: any[] = [];
  acceptEvents(server, sent);
  let confirmed = false;
  server.on('POST', '/v1/me/merge-check', () => ({ json: { confirmed } }));
  const store = memoryStore();
  // Left by the account that was merged away: one event and one stat waiting.
  await store.set('krtu:buried.test.web:events:pw_source_aaaaaaaaaa', {
    pending: [{ id: '0192f2a1-0000-7000-8000-000000000001', type: 'button', createdAt: new Date().toISOString(), launchId: '0192f2a1-0000-7000-8000-000000000002', monotonicMs: 5, data: { name: 'old' } }],
    batch: null,
    dropped: 0,
    reported: 0,
  });
  await store.set('krtu:buried.test.web:meta', { epoch: 0, waitingOwners: ['pw_source_aaaaaaaaaa'], guestRequest: null });
  const settled: string[] = [];
  const krtu = await Krtuworks.initialize(options(server, { store }));
  krtu.onMergeSettled((m) => settled.push(m.previousSubject));
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  assert.equal(sent.length, 0, 'not confirmed: the queue waits for its own account');
  assert.deepEqual(settled, []);
  confirmed = true;
  await (krtu as unknown as { settle(): Promise<void> }).settle();
  assert.deepEqual(settled, ['pw_source_aaaaaaaaaa']);
  assert.deepEqual(sent.map((e) => e.data.name), ['old'], 'confirmed: the waiting event went with this token');
  await krtu.shutdown();
});

test('a save answered 202 is asked about until final; a relaunch finishes a lost one with the same upload id', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  configRoute(server, {});
  acceptEvents(server, []);
  const version = { id: 'fil_aaaaaaaaaaaaaaaaaaaa', slot: 'save-1', device: null, generation: 1, sizeBytes: 3, sha256: 'x', platform: 'WEB', build: '1.0.0', savedAt: new Date().toISOString(), fromMerge: false };
  let polls = 0;
  const keys: string[] = [];
  server.on('PUT', '/v1/apps/buried/files/save-1', (call) => {
    keys.push(call.headers.get('idempotency-key')!);
    assert.equal(call.headers.get('if-none-match'), '*');
    return keys.length === 1 ? { status: 202, json: { uploadId: keys[0], status: 'PENDING', file: null, code: null } } : { status: 201, json: { uploadId: keys[0], status: 'ACTIVATED', file: version } };
  });
  server.on('GET', `/v1/apps/buried/files`, () => ({ json: { slots: [{ key: 'save-1', kind: 'SAVE', name: 'Save', retired: false, file: version, conflict: null, devices: [] }], limits: {} } }));
  const store = memoryStore();
  const krtu = await Krtuworks.initialize(options(server, { store }));
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  // The status route is per upload id: PENDING once more, then ACTIVATED.
  const statusRoute = (id: string) =>
    server.on('GET', `/v1/apps/buried/files/save-1/uploads/${id}`, () => {
      polls += 1;
      return { json: { uploadId: id, status: polls < 2 ? 'PENDING' : 'ACTIVATED', file: polls < 2 ? null : { id: version.id, generation: 1 }, code: null } };
    });
  const saving = krtu.files.save('save-1', new Uint8Array([1, 2, 3]), { base: null });
  await new Promise((r) => setTimeout(r, 20));
  statusRoute(keys[0]!);
  const saved = await saving;
  assert.equal(saved.id, version.id);
  assert.equal(polls, 2);
  await krtu.shutdown();

  // A lost answer: the upload stays in the store; the next launch sends it again with the same id.
  server.offline.add('/v1/apps/buried/files/save-1');
  const relaunchStore = store;
  const first = await Krtuworks.initialize(options(server, { store: relaunchStore }));
  await first.ready();
  await assert.rejects(first.files.save('save-1', new Uint8Array([9]), { base: null }), (e: unknown) => isKrtuworksError(e, 'network_error'));
  await first.shutdown();
  server.offline.clear();
  const before = keys.length;
  const second = await Krtuworks.initialize(options(server, { store: relaunchStore }));
  await second.ready();
  assert.equal(keys.length, before + 1, 'resumed on launch');
  const lostKey = server.calls.filter((c) => c.method === 'PUT').slice(-2)[0]!.headers.get('idempotency-key');
  assert.equal(keys[keys.length - 1], lostKey, 'with the same upload id');
  await second.shutdown();
});

test('a guest is reminded to link a Krtuworks ID at the first achievement, once per quiet window (control: none when the app turns it off)', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const route = configRoute(server, { linkReminder: { everyDays: 3 } });
  server.on('POST', '/v1/me/progress', (call) => ({ json: { results: call.json.ops.map((o: any) => ({ opId: o.opId, status: 'applied', type: o.type, key: o.key })) } }));
  acceptEvents(server, []);
  const store = memoryStore();
  const krtu = await Krtuworks.initialize(options(server, { store }));
  await krtu.refreshConfig();
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  const reasons: string[] = [];
  krtu.onLinkReminder((r) => reasons.push(r));
  await krtu.unlockAchievement('first_win');
  await krtu.unlockAchievement('second_win');
  assert.deepEqual(reasons, ['first_achievement'], 'once: the second achievement is not a first, and the window is quiet');
  await krtu.shutdown();

  const off = new FakeServer();
  guestRoutes(off, 'pw_other_aaaaaaaaaaaa');
  configRoute(off, { linkReminder: { enabled: false } });
  acceptEvents(off, []);
  const quiet = await Krtuworks.initialize(options(off));
  await quiet.refreshConfig();
  await quiet.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const none: string[] = [];
  quiet.onLinkReminder((r) => none.push(r));
  await quiet.unlockAchievement('first_win');
  assert.deepEqual(none, []);
  await quiet.shutdown();
  void route;
});

test('a save still being written when the player changes ends with context_changed; it is not asked about with the new token', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  configRoute(server, {});
  acceptEvents(server, []);
  server.on('PUT', '/v1/apps/buried/files/save-1', (call) => ({ status: 202, json: { uploadId: call.headers.get('idempotency-key'), status: 'PENDING', file: null, code: null } }));
  const krtu = await Krtuworks.initialize(options(server));
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  const saving = krtu.files.save('save-1', new Uint8Array([1]), { base: null });
  await new Promise((r) => setTimeout(r, 50));
  await krtu.signOut();
  await assert.rejects(saving, (e: unknown) => isKrtuworksError(e, 'context_changed'));
  assert.equal(server.calls.filter((c) => c.path.includes('/uploads/')).length, 0, 'no status call under another player');
  await krtu.shutdown();
});

test('a read that a newer local save overtook says so', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  configRoute(server, {});
  acceptEvents(server, []);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  server.on('GET', '/v1/apps/buried/files/save-1', async () => {
    await gate;
    return { body: new Uint8Array([7]), headers: { etag: '"fil_aaaaaaaaaaaaaaaaaaaa"', 'x-krtu-generation': '1' } };
  });
  server.on('PUT', '/v1/apps/buried/files/save-1', () => ({ status: 409, json: { error: { code: 'file_conflict', message: 'x' } } }));
  const krtu = await Krtuworks.initialize(options(server));
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  const reading = krtu.files.read('save-1');
  await new Promise((r) => setTimeout(r, 20));
  await krtu.files.save('save-1', new Uint8Array([8]), { base: 'fil_aaaaaaaaaaaaaaaaaaaa' }).catch(() => undefined);
  release();
  const read = await reading;
  assert.equal(read!.newerLocalSave, true);
  const plain = await krtu.files.read('save-1');
  assert.equal(plain!.newerLocalSave, false, 'control: a read with no save in between');
  await krtu.shutdown();
});

test('a platform sync answers what to clear there (support took it back); control: an older server without the list gives none', async () => {
  for (const answer of [{ unlockedHere: ['steam_only'], toPlatform: ['ACH_KRTU_ONLY'], toClear: ['ACH_TAKEN_BACK'] }, { unlockedHere: [], toPlatform: [] }]) {
    const server = new FakeServer();
    guestRoutes(server);
    configRoute(server, {});
    acceptEvents(server, []);
    let sentUnlocked: unknown = null;
    server.on('POST', '/v1/me/progress/platform-sync', (call) => {
      sentUnlocked = JSON.parse(new TextDecoder().decode(call.raw)).unlocked;
      return { json: { ...answer, serverTime: new Date().toISOString() } };
    });
    const krtu = await Krtuworks.initialize(options(server));
    await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
    await krtu.ready();
    const synced = await krtu.syncPlatformAchievements(['ACH_STEAM_ONLY', 'ACH_TAKEN_BACK']);
    assert.deepEqual(sentUnlocked, ['ACH_STEAM_ONLY', 'ACH_TAKEN_BACK']);
    assert.deepEqual(synced, { unlockedHere: answer.unlockedHere, toPlatform: answer.toPlatform, toClear: answer.toClear ?? [] });
    await krtu.shutdown();
  }
});

test("a platform sync names the open session (the server mirrors only with the account it proved), and the server's mismatch reaches the game; control: no session, none sent", async () => {
  const server = new FakeServer();
  guestRoutes(server);
  configRoute(server, {});
  acceptEvents(server, []);
  server.on('POST', '/v1/sessions', () => ({
    status: 201,
    json: { session: { id: 'ses_bbbbbbbbbbbbbbbbbbbb', startedAt: new Date().toISOString() }, heartbeatSeconds: 60, serverTime: new Date().toISOString() },
  }));
  const bodies: any[] = [];
  let mismatch = false;
  server.on('POST', '/v1/me/progress/platform-sync', (call) => {
    bodies.push(call.json);
    if (mismatch) return { status: 409, json: { error: { code: 'platform_link_mismatch', message: 'Not mirrored.' }, platform: 'STEAM', state: 'PENDING_CONSENT' } };
    return { json: { unlockedHere: [], toPlatform: [], toClear: [], serverTime: new Date().toISOString() } };
  });
  const krtu = await Krtuworks.initialize(options(server, { sessions: true }));
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  await krtu.syncPlatformAchievements([]);
  assert.equal(bodies[0].sessionId, 'ses_bbbbbbbbbbbbbbbbbbbb');
  mismatch = true;
  await assert.rejects(krtu.syncPlatformAchievements([]), (err: any) => err.code === 'platform_link_mismatch' && err.status === 409 && err.details?.state === 'PENDING_CONSENT');
  await krtu.shutdown();

  const quiet = new FakeServer();
  guestRoutes(quiet);
  configRoute(quiet, {});
  acceptEvents(quiet, []);
  const quietBodies: any[] = [];
  quiet.on('POST', '/v1/me/progress/platform-sync', (call) => {
    quietBodies.push(call.json);
    return { json: { unlockedHere: [], toPlatform: [], toClear: [], serverTime: new Date().toISOString() } };
  });
  const plain = await Krtuworks.initialize(options(quiet));
  await plain.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await plain.ready();
  await plain.syncPlatformAchievements([]);
  assert.equal('sessionId' in quietBodies[0], false);
  assert.equal(quiet.count('POST', '/v1/sessions'), 0);
  await plain.shutdown();
});

test("another tab's different player taken up on a refresh is an identity change: listeners are told once and B gets a session (control: only a refresh of A is silent)", async () => {
  const A = 'pw_guest_aaaaaaaaaaaa';
  const B = 'pw_other_bbbbbbbbbbbb';
  for (const otherPlayer of [true, false]) {
    const server = new FakeServer();
    guestRoutes(server, A);
    configRoute(server, {});
    acceptEvents(server, []);
    const sessionFor: string[] = [];
    server.on('POST', '/v1/sessions', (call) => {
      const token = (call.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      sessionFor.push(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sub);
      return { status: 201, json: { session: { id: `ses_${String(sessionFor.length).padStart(20, 'a')}`, startedAt: new Date().toISOString() }, heartbeatSeconds: 60, serverTime: new Date().toISOString() } };
    });
    const store = memoryStore();
    const tab1 = await Krtuworks.initialize(options(server, { store, sessions: true }));
    await tab1.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
    await tab1.ready();
    assert.deepEqual(sessionFor, [A]);
    const changes: Array<{ type: string; subject?: string }> = [];
    tab1.onIdentityChange((c) => changes.push({ type: c.type, subject: 'player' in c ? c.player.subject : undefined }));
    let first = true;
    server.on('GET', '/v1/me/bug-reports', async () => {
      if (!first) return { json: { reports: [], serverTime: new Date().toISOString() } };
      first = false;
      // Tab 2 writes its tokens (B, or a fresher A) while tab 1's call is on its way; tab 1's token is then refused.
      const exp = Math.floor(Date.now() / 1000) + 600;
      const subject = otherPlayer ? B : A;
      await store.set('krtu:buried.test.web:tokens', {
        kind: 'guest', subject, username: null, picture: null,
        accessToken: fakeJwt({ sub: subject, aud: 'devapi', exp, scope: 'app:player', n: 'tab2' }), accessExpiresAt: exp * 1000, refreshToken: 'rt-tab2',
      });
      return { status: 401, json: { error: { code: 'token_expired', message: 'x' } } };
    });
    if (otherPlayer) {
      await assert.rejects(tab1.myBugReports(), (e: unknown) => isKrtuworksError(e, 'context_changed'));
      await tab1.ready();
      assert.deepEqual(changes, [{ type: 'guest', subject: B }], 'told exactly once, of B');
      assert.equal(tab1.player?.subject, B);
      assert.deepEqual(sessionFor, [A, B], "B's session opened by the settle after the change");
    } else {
      assert.deepEqual(await tab1.myBugReports(), []);
      await tab1.ready();
      assert.deepEqual(changes, [], 'a plain refresh by another tab is silent');
      assert.deepEqual(sessionFor, [A]);
    }
    await tab1.shutdown();
  }
});
