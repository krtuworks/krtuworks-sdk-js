import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../src/api.js';
import { BugReports } from '../src/bugs.js';
import { Krtuworks } from '../src/client.js';
import { Clock } from '../src/clock.js';
import { resolveOptions } from '../src/config.js';
import { KrtuworksError, isKrtuworksError } from '../src/errors.js';
import { EventQueue } from '../src/events.js';
import { Files } from '../src/files.js';
import { Identity, type IdentityChange } from '../src/identity.js';
import { withLock } from '../src/locks.js';
import { ProgressionTracker } from '../src/progression.js';
import { ProgressQueue } from '../src/progress.js';
import { RemoteConfig } from '../src/remoteConfig.js';
import { SessionKeeper } from '../src/sessions.js';
import { memoryStore, type KrtuStore } from '../src/store.js';
import { send } from '../src/transport.js';
import { KrtuworksUi, errorScreen, type UiAnswer, type UiHost, type UiScreen } from '../src/ui/core.js';
import { FakeServer, guestRoutes, options, type Reply } from './fakeServer.js';

const TERMS = { birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' };
const A = 'pw_guest_aaaaaaaaaaaa';
const UPLOADS = 'krtu:buried.test.web:upload:';
const BUGS = 'krtu:buried.test.web:bugs:';
const EVENTS = `krtu:buried.test.web:events:${A}`;

async function signedIn(server: FakeServer, store: KrtuStore = memoryStore(), extra = {}) {
  guestRoutes(server, A);
  const krtu = await Krtuworks.initialize(options(server, { store, ...extra }));
  await krtu.signInAsGuest(TERMS);
  await krtu.ready();
  return { krtu, store };
}

/** The pieces of the SDK wired by hand over one identity, for tests that reach below the client. */
async function rig(server: FakeServer, store: KrtuStore = memoryStore(), settingsWriteMs = 0) {
  guestRoutes(server, A);
  const opts = resolveOptions({ ...options(server), store });
  const clock = new Clock();
  const identity = new Identity({ opts, store, fetch: server.fetch, clock });
  await identity.signInAsGuest(TERMS);
  const api = new Api(opts, identity, server.fetch, clock);
  const subject = () => identity.player?.subject ?? null;
  return {
    opts,
    clock,
    identity,
    api,
    store,
    events: new EventQueue({ opts, store, clock, api, subject }),
    progress: new ProgressQueue({ opts, store, api, subject }),
    files: new Files(opts, api, store, subject, () => identity.generation, () => undefined, settingsWriteMs),
    bugs: new BugReports(opts, store, api, () => subject() ?? 'anon', subject),
  };
}

/** Waits (up to 5 s) until `done()` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 250 && !done(); i += 1) await new Promise((r) => setTimeout(r, 20));
}

const refusal = (status: number, code: string, extra: Record<string, unknown> = {}): Reply => ({ status, json: { error: { code, message: code }, ...extra } });

// ── An error from the credentials is not a refusal of the item ───────────────

test('a refresh the server refuses (app_suspended) keeps the queued events, bug report and save (control: a refresh that works sends them)', async () => {
  for (const frozen of [true, false]) {
    const server = new FakeServer();
    const { krtu, store } = await signedIn(server);
    krtu.track('screen_view', { screen: 'menu' });
    await krtu.reportBug({ category: 'OTHER', description: 'It broke.' });
    const saving = krtu.files.save('save-1', new Uint8Array([1, 2, 3]), { base: null }).catch((e: unknown) => e);
    let tokenExpired = true;
    const answer = (call: { path: string }): Reply => {
      if (frozen || tokenExpired) {
        tokenExpired = false;
        return refusal(401, 'token_expired');
      }
      if (call.path === '/v1/events') return { json: { batchId: 'b', accepted: [], duplicate: [], rejected: [], retry: [], telemetry: true } };
      if (call.path === '/v1/me/bug-reports') return { status: 201, json: { created: true, report: { id: 'bug_aaaaaaaaaaaaaaaaaaaa' } } };
      return { status: 201, json: { file: { id: 'fil_aaaaaaaaaaaaaaaaaaaa', slot: 'save-1', generation: 1 } } };
    };
    server.on('POST', '/v1/events', (call) => (frozen ? refusal(401, 'token_expired') : { json: { accepted: JSON.parse(new TextDecoder().decode(call.raw)).events.map((e: { id: string }) => e.id), duplicate: [], rejected: [], retry: [], telemetry: true } }));
    server.on('POST', '/v1/me/bug-reports', (call) => answer(call));
    server.on('PUT', '/v1/apps/buried/files/save-1', (call) => (frozen ? refusal(401, 'token_expired') : answer(call)));
    server.on('POST', '/oidc/token', (call) =>
      frozen && call.form!.get('grant_type') === 'refresh_token'
        ? { status: 400, json: { error: 'invalid_grant', error_description: 'app_suspended' } }
        : { json: { access_token: 'x' } },
    );
    const refreshed = await saving;
    const result = await krtu.flush();
    if (frozen) {
      assert.ok(isKrtuworksError(refreshed), 'the save call failed');
      assert.equal((refreshed as KrtuworksError).authLayer, true);
      const waiting = await krtu.waiting();
      assert.equal(waiting.events, 1, 'the event stays');
      assert.equal(waiting.bugReports, 1, 'the report stays');
      assert.equal((await store.keys(UPLOADS)).length, 1, 'the save stays');
      assert.equal(result.events.stoppedBy, 'invalid_grant');
      const again = await krtu.flush();
      assert.equal(again.events.stoppedBy, 'waiting', 'a frozen app is not asked again at once');
    }
    await krtu.shutdown();
  }
});

test('refusals that can lift keep a queued save; a refusal of the body drops it (control)', async () => {
  const cases: Array<[number, string, boolean]> = [
    [401, 'account_merged', true],
    [403, 'sanctioned', true],
    [403, 'account_deletion_pending', true],
    [403, 'switched_off', true],
    [403, 'module_disabled', true],
    [403, 'app_suspended', true],
    [400, 'invalid_request', false],
    [413, 'payload_too_large', false],
  ];
  for (const [status, code, kept] of cases) {
    const server = new FakeServer();
    const { files, store } = await rig(server);
    server.on('PUT', '/v1/apps/buried/files/save-1', () => refusal(status, code));
    await assert.rejects(files.save('save-1', new Uint8Array([1]), { base: null }), (e: unknown) => isKrtuworksError(e, code));
    assert.equal((await store.keys(UPLOADS)).length, kept ? 1 : 0, `${status} ${code}`);
  }
});

test('a save kept after account_merged is offered by waitingFor to the player\'s choice', async () => {
  const server = new FakeServer();
  const { files, identity } = await rig(server);
  server.on('PUT', '/v1/apps/buried/files/save-1', () => refusal(401, 'account_merged', { mergedInto: 'pw_target_cccccccccccc' }));
  await assert.rejects(files.save('save-1', new Uint8Array([7]), { base: null }), (e: unknown) => isKrtuworksError(e, 'account_merged'));
  assert.equal((await files.waitingFor(A)).length, 1);
  assert.ok((await identity.waitingOwners()).includes(A));
  const [waiting] = await files.waitingFor(A);
  await files.discardWaiting(waiting!.uploadId);
  assert.equal((await files.waitingFor(A)).length, 0);
});

test('events and progress wait on a waiting refusal and back off a long while; a 400 on the batch still drops it (control)', async () => {
  for (const status of [403, 400]) {
    const server = new FakeServer();
    const { events, progress, store } = await rig(server);
    events.add({ type: 'screen_view', data: { screen: 'a' } });
    await progress.learnKinds([{ key: 'coins', kind: 'SUM' }]);
    await progress.report('add', 'coins', 2);
    const code = status === 403 ? 'switched_off' : 'invalid_request';
    server.on('POST', '/v1/events', () => refusal(status, code));
    server.on('POST', '/v1/me/progress', () => refusal(status, code));
    const first = await events.flush();
    assert.equal(first.stoppedBy, code);
    const state = await store.get<{ pending: unknown[]; batch: unknown; dropped: number }>(EVENTS);
    if (status === 403) {
      assert.ok(state?.batch, 'the frozen batch stays');
      assert.equal((await events.flush()).stoppedBy, 'waiting');
      assert.equal((await progress.flush()).stoppedBy, code);
      assert.equal(await progress.waiting(A), 1);
      assert.equal((await progress.flush()).stoppedBy, 'waiting');
    } else {
      assert.equal(state?.batch ?? null, null, 'the refused batch is dropped');
    }
  }
});

// ── Bug screenshot ─────────────────────────────────────────────────────────

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('a transient 409 on the screenshot keeps it for another try; a definitive one drops it (control)', async () => {
  for (const [code, kept] of [['app_transferring', true], ['account_merging', true], ['screenshot_too_late', false]] as const) {
    const server = new FakeServer();
    const { krtu, store } = await signedIn(server);
    server.on('POST', '/v1/me/bug-reports', () => ({ status: 201, json: { created: true, report: { id: 'bug_aaaaaaaaaaaaaaaaaaaa' } } }));
    server.on('PUT', '/v1/me/bug-reports/bug_aaaaaaaaaaaaaaaaaaaa/screenshot', () => refusal(409, code));
    await krtu.reportBug({ category: 'OTHER', description: 'It broke.', screenshot: PNG });
    const result = await krtu.flush();
    assert.equal((await store.keys(BUGS)).length, kept ? 1 : 0, code);
    if (kept) {
      assert.equal(result.bugs.stoppedBy, code);
      assert.deepEqual(result.bugs.dropped, []);
    } else {
      assert.deepEqual(result.bugs.dropped.map((d) => [d.code, d.screenshotOnly]), [[code, true]]);
    }
    await krtu.shutdown();
  }
});

test('a report that was refused and is gone from the queue leaves no wait entry behind', async () => {
  const server = new FakeServer();
  const { bugs, store } = await rig(server);
  server.on('POST', '/v1/me/bug-reports', () => refusal(503, 'busy'));
  await bugs.report({ category: 'OTHER', description: 'x' }, null);
  await bugs.flush();
  const wait = (bugs as unknown as { waitUntil: Map<string, number> }).waitUntil;
  assert.equal(wait.size, 1);
  for (const key of await store.keys(BUGS)) await store.delete(key);
  await bugs.flush();
  assert.equal(wait.size, 0);
});

// ── Settings write pace ─────────────────────────────────────────────────────

function settingsRoute(server: FakeServer, taken: string[]) {
  server.on('PUT', '/v1/apps/buried/files/settings', (call) => {
    taken.push(new TextDecoder().decode(call.raw));
    return { status: 201, json: { file: { id: 'fil_aaaaaaaaaaaaaaaaaaaa', slot: 'settings', generation: taken.length } } };
  });
}

test('a settings slot takes one write per window, the newest content winning (control: a save with a base is sent at once)', async () => {
  const server = new FakeServer();
  const { files } = await rig(server, memoryStore(), 150);
  const taken: string[] = [];
  settingsRoute(server, taken);
  const enc = (t: string) => new TextEncoder().encode(t);
  await files.save('settings', enc('v1'));
  assert.deepEqual(taken, ['v1'], 'the first goes at once');
  const second = files.save('settings', enc('v2'));
  const third = files.save('settings', enc('v3'));
  await assert.rejects(second, (e: unknown) => isKrtuworksError(e, 'save_replaced'));
  assert.deepEqual(taken, ['v1'], 'nothing more inside the window');
  await third;
  assert.deepEqual(taken, ['v1', 'v3'], 'the newest went when the window ended');

  const based: string[] = [];
  server.on('PUT', '/v1/apps/buried/files/save-1', (call) => {
    based.push(new TextDecoder().decode(call.raw));
    return { status: 201, json: { file: { id: 'fil_bbbbbbbbbbbbbbbbbbbb', slot: 'save-1', generation: based.length } } };
  });
  await files.save('save-1', enc('a'), { base: null });
  await files.save('save-1', enc('b'), { base: 'fil_bbbbbbbbbbbbbbbbbbbb' });
  assert.deepEqual(based, ['a', 'b'], 'no waiting for a save with a base');
});

test('a large settings save started before a small newer one never lands after it (control: saves awaited in turn go in turn)', async () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const large = new Uint8Array(4 * 1024 * 1024).fill(65);
  for (const windowMs of [0, 60_000]) {
    const server = new FakeServer();
    const { files } = await rig(server, memoryStore(), windowMs);
    const taken: string[] = [];
    settingsRoute(server, taken);
    await files.save('settings', enc('v1'));
    const older = files.save('settings', large);
    const newer = files.save('settings', enc('B'));
    if (windowMs) await files.flushWrites();
    const outcome = await Promise.allSettled([older, newer]);
    assert.equal(taken[taken.length - 1], 'B', `the newest content is the last written (window ${windowMs})`);
    if (outcome[0].status === 'rejected') assert.ok(isKrtuworksError(outcome[0].reason, 'save_replaced'));
    assert.equal(outcome[1].status, 'fulfilled');
  }
  const server = new FakeServer();
  const { files } = await rig(server);
  const taken: string[] = [];
  settingsRoute(server, taken);
  await files.save('settings', enc('B'));
  await files.save('settings', large);
  assert.equal(taken.length, 2);
  assert.notEqual(taken[1], 'B', 'awaited in turn, the later save is the last written');
});

test('flushWrites sends the held settings now (control: nothing is sent while the window runs)', async () => {
  const server = new FakeServer();
  const { files } = await rig(server, memoryStore(), 60_000);
  const taken: string[] = [];
  settingsRoute(server, taken);
  const enc = (t: string) => new TextEncoder().encode(t);
  await files.save('settings', enc('v1'));
  const held = files.save('settings', enc('v2'));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(taken, ['v1']);
  await files.flushWrites();
  await held;
  assert.deepEqual(taken, ['v1', 'v2']);
});

test('a too_many_writes answer is tried again after its Retry-After with the same upload id (control: another refusal is not)', async () => {
  for (const code of ['too_many_writes', 'invalid_request']) {
    const server = new FakeServer();
    const { files } = await rig(server);
    const ids: string[] = [];
    server.on('PUT', '/v1/apps/buried/files/save-1', (call) => {
      ids.push(call.headers.get('idempotency-key')!);
      if (ids.length === 1) return { ...refusal(code === 'too_many_writes' ? 429 : 400, code), headers: { 'retry-after': '1' } };
      return { status: 201, json: { file: { id: 'fil_aaaaaaaaaaaaaaaaaaaa', slot: 'save-1', generation: 1 } } };
    });
    await assert.rejects(files.save('save-1', new Uint8Array([1]), { base: null }), (e: unknown) => isKrtuworksError(e, code));
    if (code === 'too_many_writes') await until(() => ids.length >= 2);
    else await new Promise((r) => setTimeout(r, 1300));
    if (code === 'too_many_writes') {
      assert.equal(ids.length, 2);
      assert.equal(ids[1], ids[0]);
    } else {
      assert.equal(ids.length, 1);
    }
  }
});

test('a held settings save of a rate-limited slot stays pending until the retry lands', async () => {
  const server = new FakeServer();
  const { files } = await rig(server);
  const ids: string[] = [];
  server.on('PUT', '/v1/apps/buried/files/settings', (call) => {
    ids.push(call.headers.get('idempotency-key')!);
    if (ids.length === 1) return { ...refusal(429, 'too_many_writes'), headers: { 'retry-after': '1' } };
    return { status: 201, json: { file: { id: 'fil_aaaaaaaaaaaaaaaaaaaa', slot: 'settings', generation: 1 } } };
  });
  const file = await files.save('settings', new TextEncoder().encode('v1'));
  assert.equal(file.slot, 'settings');
  assert.equal(ids.length, 2);
});

// ── The replayed conflict ───────────────────────────────────────────────────

test('an upload whose record says file_conflict carries the slot\'s current version (control: another refusal carries none)', async () => {
  for (const code of ['file_conflict', 'write_failed']) {
    const server = new FakeServer();
    const { files } = await rig(server);
    const current = { id: 'fil_bbbbbbbbbbbbbbbbbbbb', slot: 'save-1', device: null, generation: 4, sizeBytes: 3, sha256: '', platform: null, build: null, savedAt: '2026-06-01T11:00:00Z', fromMerge: false };
    server.on('PUT', '/v1/apps/buried/files/save-1', (call) => ({ status: 202, json: { uploadId: call.headers.get('idempotency-key'), status: 'PENDING', file: null, code: null } }));
    server.onPrefix('GET', '/v1/apps/buried/files/save-1/uploads/', (call) => ({ json: { uploadId: call.path.split('/').pop(), status: 'REJECTED', file: null, code } }));
    server.on('GET', '/v1/apps/buried/files', () => ({ json: { slots: [{ key: 'save-1', kind: 'SAVE', name: 'Save', retired: false, file: current, conflict: null, devices: [] }], limits: {} } }));
    const err = await files.save('save-1', new Uint8Array([1]), { base: 'fil_aaaaaaaaaaaaaaaaaaaa' }).catch((e: unknown) => e);
    assert.ok(isKrtuworksError(err, code));
    assert.deepEqual((err as KrtuworksError).details.current, code === 'file_conflict' ? current : undefined);
  }
});

// ── Session ─────────────────────────────────────────────────────────────────

function keeperRig(subject: { now: string | null }, onOpen: (call: { owner?: string }) => Promise<unknown>) {
  const opts = resolveOptions(options(new FakeServer()));
  const api = { player: async (_path: string, call: { owner?: string }) => ({ json: await onOpen(call) }) } as unknown as Api;
  return new SessionKeeper(opts, api, () => subject.now);
}

test('a session whose open failed is opened again when asked (control: after close nothing is wanted)', async () => {
  const subject = { now: A as string | null };
  let calls = 0;
  const keeper = keeperRig(subject, async () => {
    calls += 1;
    if (calls === 1) throw new KrtuworksError('network_error', 'offline');
    return { session: { id: 's1', startedAt: '2026-06-01T00:00:00Z' }, heartbeatSeconds: 3600 };
  });
  assert.equal(await keeper.start(), null);
  assert.equal(keeper.session, null);
  keeper.ensure(true);
  await until(() => keeper.session !== null);
  assert.equal(keeper.session?.id, 's1');
  assert.equal(calls, 2);
  keeper.close();
  keeper.ensure(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2, 'a closed keeper does not open again');
});

test('ensure waits for its time while a retry is scheduled (control: forced, it opens at once)', async () => {
  const subject = { now: A as string | null };
  let calls = 0;
  const keeper = keeperRig(subject, async () => {
    calls += 1;
    throw new KrtuworksError('busy', 'busy', 503);
  });
  await keeper.start();
  keeper.ensure();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  keeper.ensure(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2);
  keeper.close();
});

test('an open in flight for another player is not handed to this one (control: the same player shares it)', async () => {
  for (const sameOwner of [false, true]) {
    const subject = { now: 'pw_first_aaaaaaaaaaaa' as string | null };
    const release: Array<() => void> = [];
    const owners: string[] = [];
    const keeper = keeperRig(subject, (call) => {
      owners.push(call.owner ?? '');
      return new Promise((resolve) => release.push(() => resolve({ session: { id: `s${owners.length}`, startedAt: '2026-06-01T00:00:00Z' }, heartbeatSeconds: 3600 })));
    });
    const first = keeper.open();
    await new Promise((r) => setTimeout(r, 5));
    if (!sameOwner) subject.now = 'pw_second_bbbbbbbbbbbb';
    const second = keeper.open();
    await new Promise((r) => setTimeout(r, 5));
    release.forEach((r) => r());
    await first;
    await new Promise((r) => setTimeout(r, 5));
    release.forEach((r) => r());
    const got = await second;
    if (sameOwner) {
      assert.equal(owners.length, 1);
      assert.equal(got?.id, 's1');
    } else {
      assert.equal(owners.length, 2);
      assert.equal(got?.owner, 'pw_second_bbbbbbbbbbbb');
    }
    keeper.close();
  }
});

// ── Identity ────────────────────────────────────────────────────────────────

test('guest meta is written under the identity lock: held, nothing is stored; released, the guest is made', async () => {
  const server = new FakeServer();
  guestRoutes(server, A);
  const store = memoryStore();
  const opts = resolveOptions({ ...options(server), store });
  const identity = new Identity({ opts, store, fetch: server.fetch, clock: new Clock() });
  let release!: () => void;
  const held = withLock(`krtu:${opts.clientId}:identity`, () => new Promise<void>((r) => (release = r)));
  const making = identity.signInAsGuest(TERMS);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await identity.meta()).guestRequest, null, 'the request waits for the lock');
  release();
  await held;
  assert.equal((await making).subject, A);
});

test('a refused date of birth ends the stored request; a terms refusal keeps it and new terms replace the old', async () => {
  for (const code of ['too_young', 'invalid_birth_date', 'terms_required']) {
    const server = new FakeServer();
    guestRoutes(server, A);
    server.on('POST', '/oidc/token', () => ({ status: 400, json: { error: code, error_description: 'Accept the current terms: TERMS:v2 PRIVACY:v1.' } }));
    const store = memoryStore();
    const opts = resolveOptions({ ...options(server), store });
    const identity = new Identity({ opts, store, fetch: server.fetch, clock: new Clock() });
    await assert.rejects(identity.signInAsGuest(TERMS), (e: unknown) => isKrtuworksError(e, code));
    const kept = (await identity.meta()).guestRequest;
    if (code === 'terms_required') {
      assert.deepEqual(kept, TERMS);
      await assert.rejects(identity.signInAsGuest({ acceptedTerms: 'TERMS:v2 PRIVACY:v1' }), (e: unknown) => isKrtuworksError(e, code));
      assert.deepEqual((await identity.meta()).guestRequest, { birthDate: '2000-01-01', acceptedTerms: 'TERMS:v2 PRIVACY:v1' });
    } else {
      assert.equal(kept, null);
    }
  }
});

test('sign-ins the player never came back to are swept; a fresh one stays', async () => {
  const server = new FakeServer();
  const { identity, store } = await rig(server);
  await store.set('krtu:buried.test.web:signin:old', { verifier: 'v', nonce: 'n', redirectUri: 'https://play.example/callback', epoch: 0, startedAt: Date.now() - 11 * 60_000 });
  await store.set('krtu:buried.test.web:signin:fresh', { verifier: 'v', nonce: 'n', redirectUri: 'https://play.example/callback', epoch: 0, startedAt: Date.now() - 60_000 });
  await identity.beginSignIn();
  const left = await store.keys('krtu:buried.test.web:signin:');
  assert.ok(!left.includes('krtu:buried.test.web:signin:old'));
  assert.ok(left.includes('krtu:buried.test.web:signin:fresh'));
  assert.equal(left.length, 2, 'the fresh one and the one just made');
});

test('401 account_deleted signs the player out, tells the app with the subject and drops what waited for them (control: token_expired alone does not)', async () => {
  for (const deleted of [true, false]) {
    const server = new FakeServer();
    const { krtu, store } = await signedIn(server);
    const changes: IdentityChange[] = [];
    krtu.onIdentityChange((c) => changes.push(c));
    krtu.track('screen_view', { screen: 'menu' });
    await krtu.reportBug({ category: 'OTHER', description: 'It broke.' });
    await krtu.incrementStat('coins', 1);
    server.on('PUT', '/v1/apps/buried/files/save-1', () => (deleted ? refusal(401, 'account_deleted') : refusal(503, 'busy')));
    await assert.rejects(krtu.files.save('save-1', new Uint8Array([1]), { base: null }));
    server.on('POST', '/v1/events', () => refusal(401, deleted ? 'account_deleted' : 'token_expired'));
    server.on('POST', '/v1/me/progress', () => refusal(503, 'busy'));
    server.on('POST', '/v1/me/bug-reports', () => refusal(503, 'busy'));
    await krtu.flush();
    await new Promise((r) => setTimeout(r, 30));
    if (deleted) {
      assert.deepEqual(changes.filter((c) => c.type === 'signed_out'), [{ type: 'signed_out', reason: 'account_deleted', subject: A }]);
      assert.equal(krtu.player, null);
      assert.equal((await store.keys(UPLOADS)).length, 0);
      assert.equal((await store.keys(BUGS)).length, 0);
      assert.equal((await store.keys(`krtu:buried.test.web:progress:`)).length, 0);
      assert.equal((await store.keys(`krtu:buried.test.web:events:`)).length, 0);
    } else {
      assert.equal(changes.filter((c) => c.type === 'signed_out').length, 0);
      assert.equal(krtu.player?.subject, A);
      assert.equal((await store.keys(UPLOADS)).length, 1);
    }
    await krtu.shutdown();
  }
});

test('a merge in progress is told once, and once when calls go through again (control: no merge tells nothing)', async () => {
  for (const merging of [true, false]) {
    const server = new FakeServer();
    const { krtu } = await signedIn(server);
    const states: string[] = [];
    krtu.onIdentityChange((c) => {
      if (c.type === 'merging') states.push(c.state);
    });
    let phase = merging ? 'merging' : 'ok';
    server.on('POST', '/v1/events', (call) =>
      phase === 'merging'
        ? refusal(409, 'account_merging')
        : { json: { accepted: JSON.parse(new TextDecoder().decode(call.raw)).events.map((e: { id: string }) => e.id), duplicate: [], rejected: [], retry: [], telemetry: true } },
    );
    krtu.track('screen_view', { screen: 'a' });
    await krtu.flush();
    krtu.track('screen_view', { screen: 'b' });
    (krtu as unknown as { events: EventQueue }).events.resetBackoff();
    await krtu.flush();
    assert.deepEqual(states, merging ? ['started'] : []);
    phase = 'ok';
    (krtu as unknown as { events: EventQueue }).events.resetBackoff();
    await krtu.flush();
    assert.deepEqual(states, merging ? ['started', 'ended'] : []);
    await krtu.shutdown();
  }
});

// ── Events ──────────────────────────────────────────────────────────────────

test('events a refused store write took are kept in memory and written next time (control: a working store loses none)', async () => {
  for (const failing of [true, false]) {
    const server = new FakeServer();
    guestRoutes(server, A);
    const inner = memoryStore();
    let broken = failing;
    const store: KrtuStore = {
      ...inner,
      async set(key, value) {
        if (broken && key.includes(':events:')) throw new Error('quota');
        return inner.set(key, value);
      },
    };
    const { events } = await rig(server, store);
    events.add({ type: 'screen_view', data: { screen: 'a' } });
    events.add({ type: 'screen_view', data: { screen: 'b' } });
    if (failing) await assert.rejects(events.persist(), /quota/);
    else await events.persist();
    broken = false;
    await events.persist();
    assert.equal(await events.size(A), 2);
    assert.equal(((await inner.get<{ pending: unknown[] }>(EVENTS))?.pending ?? []).length, 2);
  }
});

test('the queue age limit reads an event on the server clock: a device clock that was behind does not drop it (control: a really old one goes)', async () => {
  const server = new FakeServer();
  const { events, store } = await rig(server);
  const day = 86_400_000;
  const old = (id: string, age: number, offset?: number) => ({ id, type: 'screen_view', createdAt: new Date(Date.now() - age * day).toISOString(), launchId: 'l', monotonicMs: 1, ...(offset !== undefined ? { serverOffsetMs: offset } : {}) });
  await store.set(EVENTS, { pending: [old('behind', 40, 39 * day), old('really-old', 40, 0), old('fresh', 1)], batch: null, dropped: 0, reported: 0 });
  events.add({ type: 'screen_view', data: { screen: 'now' } });
  await events.persist();
  const state = (await store.get<{ pending: Array<{ id: string }> }>(EVENTS))!;
  const ids = state.pending.map((e) => e.id);
  assert.ok(ids.includes('behind'));
  assert.ok(ids.includes('fresh'));
  assert.ok(!ids.includes('really-old'));
});

// ── Remote config ───────────────────────────────────────────────────────────

test('a 2xx config answer that is not a config leaves the kept copy alone (control: a real one is stored)', async () => {
  for (const body of [{ html: true }, 'json']) {
    const server = new FakeServer();
    const { opts, api, store } = await rig(server);
    const config = new RemoteConfig(opts, api, store);
    server.on('GET', '/v1/apps/buried/config', () => ({ json: { appId: 'a', environment: 'TEST', platform: 'WEB', version: '1', config: { modules: { economy: false } }, switches: [], serverTime: new Date().toISOString() }, headers: { etag: '"v1"' } }));
    await config.refresh();
    assert.equal(config.moduleOn('economy'), false);
    server.on('GET', '/v1/apps/buried/config', () => (body === 'json' ? { status: 200, body: new TextEncoder().encode('<html>portal</html>'), headers: { 'content-type': 'text/html' } } : { json: body }));
    await assert.rejects(config.refresh(), (e: unknown) => isKrtuworksError(e, 'invalid_response'));
    assert.equal(config.moduleOn('economy'), false, 'the kept copy still switches economy off');
    const fresh = new RemoteConfig(opts, api, store);
    await fresh.load();
    assert.equal(fresh.moduleOn('economy'), false, 'and so does what the store holds');
  }
});

// ── Level attempt ───────────────────────────────────────────────────────────

test('an open level attempt belongs to its player: after a switch nothing is told under the new one (control: the same player completes)', async () => {
  for (const switched of [true, false]) {
    let owner = 'pw_first_aaaaaaaaaaaa';
    const told: string[] = [];
    const tracker = new ProgressionTracker(memoryStore(), 'c', () => owner, () => 0, (data) => told.push(`${owner}:${data.action}`));
    await tracker.start({ level: '1-1' });
    if (switched) owner = 'pw_second_bbbbbbbbbbbb';
    tracker.finish('complete', { score: 5 });
    assert.deepEqual(told, switched ? ['pw_first_aaaaaaaaaaaa:start'] : ['pw_first_aaaaaaaaaaaa:start', 'pw_first_aaaaaaaaaaaa:complete']);
    assert.equal(tracker.inPlay, null);
  }
});

test('a level started before any player goes on to the first player (control: another real player does not inherit it)', async () => {
  let owner = 'anon';
  const told: string[] = [];
  const tracker = new ProgressionTracker(memoryStore(), 'c', () => owner, () => 0, (data) => told.push(data.action));
  await tracker.start({ level: '1-1' });
  owner = 'pw_first_aaaaaaaaaaaa';
  tracker.finish('complete');
  assert.deepEqual(told, ['start', 'complete']);
});

// ── First launch, clocks, refusals list ─────────────────────────────────────

test('firstLaunch online: an offline first launch says so until the server answers (control: the default starts as ready)', async () => {
  for (const setting of ['online', undefined] as const) {
    const server = new FakeServer();
    guestRoutes(server, A);
    const base = options(server);
    server.offline.add('/v1/apps/buried/config');
    const krtu = await Krtuworks.initialize({ ...base, config: { ...base.config, ...(setting ? { firstLaunch: setting } : {}) } });
    const seen: string[] = [];
    krtu.onStartupChange((s) => seen.push(s));
    assert.equal(krtu.startup, setting ? 'first_launch_offline' : 'ready');
    server.offline.delete('/v1/apps/buried/config');
    server.on('GET', '/v1/apps/buried/config', () => ({ json: { appId: 'a', environment: 'TEST', platform: 'WEB', version: '1', config: {}, switches: [], serverTime: new Date().toISOString() }, headers: { etag: '"v1"' } }));
    await krtu.refreshConfig();
    assert.equal(krtu.startup, 'ready');
    assert.deepEqual(seen, setting ? ['ready'] : []);
    await krtu.shutdown();
  }
});

test('firstLaunch online does not block a launch that kept a config before', async () => {
  const server = new FakeServer();
  guestRoutes(server, A);
  const store = memoryStore();
  const base = options(server, { store });
  const config = { ...base.config, firstLaunch: 'online' as const };
  server.on('GET', '/v1/apps/buried/config', () => ({ json: { appId: 'a', environment: 'TEST', platform: 'WEB', version: '1', config: {}, switches: [], serverTime: new Date().toISOString() }, headers: { etag: '"v1"' } }));
  const first = await Krtuworks.initialize({ ...base, config });
  await first.refreshConfig();
  await first.shutdown();
  server.offline.add('/v1/apps/buried/config');
  const second = await Krtuworks.initialize({ ...base, config });
  assert.equal(second.startup, 'ready');
  await second.shutdown();
});

test('a Retry-After date counts from the server clock, not the device clock (control: seconds are taken as they are)', async () => {
  const serverAhead = Date.now() + 3_600_000;
  const date = (ms: number) => new Date(ms).toUTCString();
  const make = (retryAfter: string): typeof fetch => async () =>
    new Response(JSON.stringify({}), { status: 429, headers: { 'content-type': 'application/json', date: date(serverAhead), 'retry-after': retryAfter } });
  const dated = await send(make(date(serverAhead + 30_000)), new Clock(), 'https://dev.krtuworks.com/v1/x', { method: 'GET' });
  assert.ok(dated.retryAfter !== null && dated.retryAfter >= 29 && dated.retryAfter <= 31, `got ${dated.retryAfter}`);
  const seconds = await send(make('12'), new Clock(), 'https://dev.krtuworks.com/v1/x', { method: 'GET' });
  assert.equal(seconds.retryAfter, 12);
});

test('the refusals kept for diagnostics stay bounded', async () => {
  const server = new FakeServer();
  const { progress } = await rig(server);
  server.on('POST', '/v1/me/progress', (call) => ({ json: { results: call.json.ops.map((o: { opId: string }) => ({ opId: o.opId, status: 'rejected', code: 'unknown_achievement' })) } }));
  for (let i = 0; i < 130; i += 1) await progress.unlock(`ach_${i}`);
  for (let i = 0; i < 3; i += 1) await progress.flush();
  assert.ok(progress.refusals.length > 0 && progress.refusals.length <= 100, `kept ${progress.refusals.length}`);
});

// ── UI ──────────────────────────────────────────────────────────────────────

test('the conflict screen marks the newer save by the server clock (control: with the device clock a server ahead of it reads wrong)', async () => {
  const server = new FakeServer();
  guestRoutes(server, A);
  const ahead = new Date(Date.now() + 3_600_000).toUTCString();
  const savedAt = new Date(Date.now() + 1_800_000).toISOString();
  const theirs = { id: 'fil_bbbbbbbbbbbbbbbbbbbb', slot: 'save-1', device: null, generation: 4, sizeBytes: 3, sha256: '', platform: null, build: '1.0.0', savedAt, fromMerge: false };
  server.on('GET', '/v1/apps/buried/files/save-1', () => ({ body: new Uint8Array([9, 9, 9]), headers: { etag: `"${theirs.id}"`, 'x-krtu-generation': '4', 'x-krtu-saved-at': savedAt, date: ahead } }));
  server.on('PUT', '/v1/apps/buried/files/save-1', (call) =>
    call.headers.get('if-match') === theirs.id
      ? { status: 201, json: { file: { ...theirs, id: 'fil_cccccccccccccccccccc' } }, headers: { date: ahead } }
      : { status: 409, json: { error: { code: 'file_conflict', message: 'x' }, current: theirs }, headers: { date: ahead } },
  );
  const krtu = await Krtuworks.initialize(options(server));
  await krtu.signInAsGuest(TERMS);
  await krtu.ready();
  const shown: UiScreen[] = [];
  const host: UiHost = {
    show(screen) {
      shown.push(screen);
      return { answer: Promise.resolve<UiAnswer>({ kind: 'keep', card: 1 }), close: () => undefined };
    },
    remind: () => ({ answer: Promise.resolve('later' as const), close: () => undefined }),
  };
  const ui = new KrtuworksUi(krtu, host);
  await ui.save('save-1', new Uint8Array([1]), { base: 'fil_aaaaaaaaaaaaaaaaaaaa' });
  const screen = shown[0] as Extract<UiScreen, { kind: 'conflict' }>;
  assert.deepEqual(screen.cards.map((c) => c.newer), [true, false], 'the server clock is past the cloud save: this device saved after it');
  await krtu.shutdown();
});

test('a pending deletion and a deleted account have their own screens that do not loop (control: a busy server retries)', () => {
  const pending = errorScreen(new KrtuworksError('account_deletion_pending', 'x', 403), {}, 'en');
  assert.equal(pending.retry, false);
  assert.match(pending.message, /cancel the deletion or download your data/);
  assert.equal(errorScreen(new KrtuworksError('account_deleted', 'x', 401), {}, 'en').retry, false);
  assert.equal(errorScreen(new KrtuworksError('guest_capacity', 'x', 503), {}, 'en').retry, true);
});
