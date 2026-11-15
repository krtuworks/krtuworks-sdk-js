import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore, type KrtuStore } from '../src/store.js';
import { configProblems, platformProblems, sentOrWhy, validate, type ValidateOptions } from '../src/validator.js';
import { FakeServer, guestRoutes, type Reply } from './fakeServer.js';

const CONFIG = {
  appId: 'app_aaaaaaaaaaaaaaaaaaaa',
  slug: 'buried',
  type: 'GAME' as const,
  environments: {
    TEST: { clientId: 'buried.test.native', webClientId: 'buried.test.web' },
    LIVE: { clientId: 'buried.live.native', webClientId: 'buried.live.web' },
  },
};

interface ServerState {
  config: Record<string, unknown>;
  stored: Uint8Array | null;
  ops: any[];
  reports: any[];
  sessionOpen: (call: any) => Reply;
  readBack: (stored: Uint8Array) => Uint8Array;
}

/** The server as the validator meets it: config, opt-out, a session, events, a SAVE slot, progress, bug reports. */
function fakeApi(server: FakeServer, over: Partial<ServerState> = {}): ServerState {
  const d: ServerState = {
    config: {},
    stored: null,
    ops: [],
    reports: [],
    sessionOpen: () => ({ status: 201, json: { session: { id: 'ses_aaaaaaaaaaaaaaaaaaaa', startedAt: new Date().toISOString() }, heartbeatSeconds: 60 } }),
    readBack: (stored) => stored,
    ...over,
  };
  guestRoutes(server);
  server.on('GET', '/v1/apps/buried/config', () => ({
    json: { appId: CONFIG.appId, environment: 'TEST', platform: 'WINDOWS', version: '1.0', config: d.config, switches: [], serverTime: new Date().toISOString() },
    headers: { etag: '"v1"' },
  }));
  server.on('GET', '/v1/me/telemetry-opt-out', () => ({ json: { optedOut: false, updatedAt: null } }));
  server.on('POST', '/v1/sessions', (call) => d.sessionOpen(call));
  server.on('POST', '/v1/sessions/ses_aaaaaaaaaaaaaaaaaaaa/heartbeat', () => ({ json: { nextHeartbeatSeconds: 60 } }));
  server.on('POST', '/v1/sessions/ses_aaaaaaaaaaaaaaaaaaaa/end', () => ({ json: { session: { id: 'ses_aaaaaaaaaaaaaaaaaaaa' } } }));
  server.on('POST', '/v1/events', (call) => {
    const body = JSON.parse(new TextDecoder().decode(call.raw));
    return { json: { batchId: body.batchId, accepted: body.events.map((e: { id: string }) => e.id), duplicate: [], rejected: [], retry: [], telemetry: true } };
  });
  const version = () => ({ id: 'fil_aaaaaaaaaaaaaaaaaaaa', slot: 'save-1', device: null, generation: 1, sizeBytes: d.stored?.length ?? 0, sha256: 'x', platform: 'WINDOWS', build: '1.0.0', savedAt: new Date().toISOString(), fromMerge: false });
  server.on('GET', '/v1/apps/buried/files', () => ({
    json: { slots: [{ key: 'save-1', kind: 'SAVE', name: 'Save', retired: false, file: d.stored ? version() : null, conflict: null, devices: [] }], limits: {} },
  }));
  server.on('PUT', '/v1/apps/buried/files/save-1', (call) => {
    d.stored = new Uint8Array(call.raw);
    return { status: 201, json: { uploadId: call.headers.get('idempotency-key'), status: 'ACTIVATED', file: version() } };
  });
  server.on('GET', '/v1/apps/buried/files/save-1', () => ({ body: d.readBack(d.stored ?? new Uint8Array()), headers: { etag: '"fil_aaaaaaaaaaaaaaaaaaaa"', 'x-krtu-generation': '1' } }));
  server.on('GET', '/v1/me/progress', () => ({
    json: {
      locale: null,
      stats: [],
      achievements: [{ key: 'first_win', id: 'ach_aaaaaaaaaaaaaaaaaaaa', name: 'First win', description: null, hidden: false, retired: false, unlocked: false, unlockedAt: null, platformIds: {}, iconUrl: null, lockedIconUrl: null }],
    },
  }));
  server.on('POST', '/v1/me/progress', (call) => {
    d.ops.push(...call.json.ops);
    return { json: { results: call.json.ops.map((o: any) => ({ opId: o.opId, status: 'applied', type: o.type, key: o.key })) } };
  });
  server.on('POST', '/v1/me/bug-reports', (call) => {
    d.reports.push(call.json);
    return { status: 201, json: { created: true, report: { id: 'bug_aaaaaaaaaaaaaaaaaaaa' } } };
  });
  return d;
}

function opts(server: FakeServer, store: KrtuStore = memoryStore(), extra: Partial<ValidateOptions> = {}): ValidateOptions {
  return { config: CONFIG, platform: 'WINDOWS', build: '1.0.0', clientKind: 'native', fetch: server.fetch, store, ...extra };
}

const statuses = (checks: Array<{ key: string; status: string }>) => Object.fromEntries(checks.map((c) => [c.key, c.status]));

test('config problems: both environments name the client of this kind (control: a whole config has none)', () => {
  assert.deepEqual(configProblems(CONFIG, 'native'), []);
  assert.deepEqual(configProblems(CONFIG, 'web'), []);
  const noLive = { ...CONFIG, environments: { TEST: CONFIG.environments.TEST } };
  assert.deepEqual(configProblems(noLive, 'native'), ['environments.LIVE has no clientId']);
  const wrong = { ...CONFIG, environments: { ...CONFIG.environments, TEST: { clientId: 'other.test.native' } } };
  assert.deepEqual(configProblems(wrong, 'native'), ['environments.TEST.clientId is other.test.native, not buried.test.native']);
  assert.match(configProblems({ ...CONFIG, appId: 'app_X' }, 'native')[0]!, /appId/);
  assert.match(configProblems({ ...CONFIG, type: 'TOOL' as never }, 'native')[0]!, /type is one of/);
  assert.deepEqual(configProblems(null, 'native'), ['the config is missing']);
});

test('platform problems: a web page needs an https return address, a native app none (control: a known platform passes)', () => {
  assert.deepEqual(platformProblems('WINDOWS', 'native', undefined), []);
  assert.deepEqual(platformProblems('WEB', 'web', 'https://play.example/callback'), []);
  assert.equal(platformProblems('WEB', 'web', 'http://play.example/callback').length, 1);
  assert.equal(platformProblems('WEB', 'web', undefined).length, 1);
  assert.equal(platformProblems('WEB', 'web', 'not a url').length, 1);
  assert.match(platformProblems('SWITCH', 'native', undefined)[0]!, /platform is one of/);
});

test("a send counts when it went, or when the item left this device unrefused (the game's own SDK on the same store sent it); otherwise why", () => {
  assert.equal(sentOrWhy(1, 0, null), null);
  assert.equal(sentOrWhy(1, 2, 'network_error'), null, 'this send went, later ones may wait');
  assert.equal(sentOrWhy(0, 0, null), null, 'another sender took it');
  assert.equal(sentOrWhy(0, 1, 'network_error'), 'network_error');
  assert.equal(sentOrWhy(0, 1, null), 'not sent');
  assert.equal(sentOrWhy(0, 0, 'switched_off'), 'switched_off');
});

test('a broken config skips the TEST run and calls no server (control: a whole config runs it)', async () => {
  const server = new FakeServer();
  fakeApi(server);
  const bad = await validate(opts(server, memoryStore(), { config: { ...CONFIG, environments: { TEST: CONFIG.environments.TEST } } }));
  assert.equal(bad.ok, false);
  assert.equal(statuses(bad.checks).config, 'FAILED');
  for (const key of ['sign_in', 'session', 'events', 'remote_config', 'cloud_save', 'progress', 'bug_report']) assert.equal(statuses(bad.checks)[key], 'SKIPPED', key);
  assert.equal(server.calls.length, 0);
  const good = await validate(opts(server));
  assert.equal(good.ok, true);
  assert.ok(server.calls.length > 0);
});

test('the TEST round passes every check the server counts, each call naming the build', async () => {
  const server = new FakeServer();
  const d = fakeApi(server);
  const report = await validate(opts(server));
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.build, '1.0.0');
  assert.deepEqual(
    report.checks.map((c) => c.key),
    ['config', 'build', 'platform', 'sign_in', 'session', 'events', 'remote_config', 'cloud_save', 'progress', 'bug_report', 'sentry'],
  );
  assert.deepEqual(statuses(report.checks), {
    config: 'PASSED', build: 'PASSED', platform: 'PASSED', sign_in: 'PASSED', session: 'PASSED', events: 'PASSED',
    remote_config: 'PASSED', cloud_save: 'PASSED', progress: 'PASSED', bug_report: 'PASSED', sentry: 'SKIPPED',
  });
  assert.equal(server.count('POST', '/v1/sessions'), 1);
  assert.equal(server.count('POST', '/v1/sessions/ses_aaaaaaaaaaaaaaaaaaaa/heartbeat'), 1);
  assert.equal(server.count('POST', '/v1/sessions/ses_aaaaaaaaaaaaaaaaaaaa/end'), 1);
  assert.match(new TextDecoder().decode(d.stored!), /^krtuworks-validator /);
  assert.equal(server.calls.find((c) => c.method === 'PUT')!.headers.get('if-none-match'), '*', 'an empty slot is written as new');
  assert.deepEqual(d.ops.map((o) => [o.type, o.key]), [['unlock', 'first_win']]);
  assert.equal(d.reports[0].category, 'OTHER');
  const reads = server.calls.filter((c) => c.path === '/v1/apps/buried/config');
  assert.ok(reads.length >= 2);
  for (const read of reads) assert.equal(read.query.get('build'), '1.0.0');
  for (const call of server.calls.filter((c) => c.path.startsWith('/v1/') && c.path !== '/v1/apps/buried/config')) assert.equal(call.headers.get('x-krtu-build'), '1.0.0', call.path);
  // The read that counts comes after the session and the events made the build known in TEST.
  const lastRead = server.calls.lastIndexOf(reads.at(-1)!);
  assert.ok(lastRead > server.calls.findIndex((c) => c.path === '/v1/sessions'));
  assert.ok(lastRead > server.calls.findIndex((c) => c.path === '/v1/events'));
});

test('the same TEST guest comes back on the next run (control: the first run made it)', async () => {
  const server = new FakeServer();
  fakeApi(server);
  const store = memoryStore();
  await validate(opts(server, store));
  const tokens = server.count('POST', '/oidc/token');
  assert.equal(server.count('POST', '/oidc/device-key/challenge'), 1);
  const again = await validate(opts(server, store));
  assert.equal(again.ok, true);
  assert.equal(server.count('POST', '/oidc/device-key/challenge'), 1, 'no new guest');
  assert.equal(server.count('POST', '/oidc/token'), tokens, 'the kept token still works');
  assert.equal(server.calls.filter((c) => c.method === 'PUT').at(-1)!.headers.get('if-match'), 'fil_aaaaaaaaaaaaaaaaaaaa', 'the second save replaces the first');
});

test('a module the owner switched off is skipped, not failed (control: the module that is on still runs)', async () => {
  const server = new FakeServer();
  fakeApi(server, { config: { modules: { sessions: false, cloudSave: false, achievements: false, bugReports: false } } });
  const report = await validate(opts(server));
  assert.equal(report.ok, true);
  const s = statuses(report.checks);
  assert.equal(s.session, 'SKIPPED');
  assert.equal(s.cloud_save, 'SKIPPED');
  assert.equal(s.progress, 'SKIPPED');
  assert.equal(s.bug_report, 'SKIPPED');
  assert.equal(s.events, 'PASSED');
  assert.equal(server.count('POST', '/v1/sessions'), 0);
  assert.equal(server.count('POST', '/v1/me/bug-reports'), 0);
});

test("a server refusal fails its own check with the server's code, the rest still run", async () => {
  const server = new FakeServer();
  fakeApi(server, {
    sessionOpen: () => ({ status: 400, json: { error: { code: 'platform_not_registered', message: 'WINDOWS is not one of the app platforms.' } } }),
    readBack: (stored) => stored.slice(1),
  });
  const report = await validate(opts(server));
  assert.equal(report.ok, false);
  const session = report.checks.find((c) => c.key === 'session')!;
  assert.equal(session.status, 'FAILED');
  assert.match(session.detail!, /^platform_not_registered/);
  assert.equal(statuses(report.checks).cloud_save, 'FAILED', 'the save read back differs');
  assert.equal(statuses(report.checks).events, 'PASSED');
  assert.equal(statuses(report.checks).bug_report, 'PASSED');
});

test("a slot's write limit is sat out: the same save goes again with the same upload id (control: a limit too long fails)", async () => {
  for (const retryAfter of [1, 60]) {
    const server = new FakeServer();
    const d = fakeApi(server);
    let refused = 0;
    server.on('PUT', '/v1/apps/buried/files/save-1', (call) => {
      if (refused === 0) {
        refused += 1;
        return { status: 429, json: { error: { code: 'too_many_writes', message: 'One write per 10 seconds.' }, retryAfter }, headers: { 'retry-after': String(retryAfter) } };
      }
      d.stored = new Uint8Array(call.raw);
      return { status: 201, json: { uploadId: call.headers.get('idempotency-key'), status: 'ACTIVATED', file: { id: 'fil_aaaaaaaaaaaaaaaaaaaa', slot: 'save-1', generation: 1 } } };
    });
    const report = await validate(opts(server));
    const save = report.checks.find((c) => c.key === 'cloud_save')!;
    const puts = server.calls.filter((c) => c.method === 'PUT');
    if (retryAfter === 1) {
      assert.equal(save.status, 'PASSED', save.detail ?? '');
      assert.equal(puts.length, 2);
      assert.equal(puts[1]!.headers.get('idempotency-key'), puts[0]!.headers.get('idempotency-key'));
    } else {
      assert.equal(save.status, 'FAILED');
      assert.match(save.detail!, /^too_many_writes/);
      assert.equal(puts.length, 1);
    }
  }
});

test('a guest that cannot be made fails sign-in and skips the rest', async () => {
  const server = new FakeServer();
  fakeApi(server);
  const report = await validate(opts(server, memoryStore(), { acceptedTerms: 'TERMS:v0' }));
  assert.equal(report.ok, false);
  const s = statuses(report.checks);
  assert.equal(s.sign_in, 'FAILED');
  for (const key of ['session', 'events', 'remote_config', 'cloud_save', 'progress', 'bug_report']) assert.equal(s[key], 'SKIPPED', key);
  assert.equal(server.count('POST', '/v1/sessions'), 0);
});
