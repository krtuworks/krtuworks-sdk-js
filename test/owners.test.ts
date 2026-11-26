import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../src/api.js';
import { Clock } from '../src/clock.js';
import { resolveOptions } from '../src/config.js';
import { isKrtuworksError } from '../src/errors.js';
import { EventQueue } from '../src/events.js';
import { Files } from '../src/files.js';
import { Identity } from '../src/identity.js';
import { ProgressQueue } from '../src/progress.js';
import { memoryStore, type KrtuStore } from '../src/store.js';
import { FakeServer, fakeJwt, guestRoutes, options, type Call } from './fakeServer.js';

const A = 'pw_guest_aaaaaaaaaaaa';
const B = 'pw_other_bbbbbbbbbbbb';
const TOKENS = 'krtu:buried.test.web:tokens';
const UPLOADS = 'krtu:buried.test.web:upload:';

/** Whose token a call carried. */
function bearer(call: Call): string {
  const token = (call.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sub;
}

/** B's tokens written as another tab writes them when it signs B in. */
async function anotherTabSignsIn(store: KrtuStore, subject = B): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + 600;
  await store.set(TOKENS, {
    kind: 'guest',
    subject,
    username: null,
    picture: null,
    accessToken: fakeJwt({ sub: subject, aud: 'devapi', exp, scope: 'app:player' }),
    accessExpiresAt: exp * 1000,
    refreshToken: 'rt-other',
  });
}

/** A store whose writes of `gated` keys wait until `release()`. */
function gatedStore(gated: (key: string) => boolean): { store: KrtuStore; release: () => void; reached: Promise<void> } {
  const inner = memoryStore();
  let release!: () => void;
  let reach!: () => void;
  const open = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (reach = r));
  return {
    store: {
      ...inner,
      async set(key, value) {
        if (gated(key)) {
          reach();
          await open;
        }
        return inner.set(key, value);
      },
    },
    release,
    reached,
  };
}

async function rig(server: FakeServer, store: KrtuStore = memoryStore(), fetchFn: typeof fetch = server.fetch) {
  guestRoutes(server, A);
  const opts = resolveOptions({ ...options(server), store, fetch: fetchFn });
  const clock = new Clock();
  const identity = new Identity({ opts, store, fetch: fetchFn, clock });
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const api = new Api(opts, identity, fetchFn, clock);
  const subject = () => identity.player?.subject ?? null;
  return {
    identity,
    store,
    progress: new ProgressQueue({ opts, store, api, subject }),
    events: new EventQueue({ opts, store, clock, api, subject }),
    files: new Files(opts, api, store, subject, () => identity.generation, () => undefined, 0),
  };
}

const applyAll = (call: Call) => ({
  json: { results: call.json.ops.map((o: { opId: string; type: string; key: string; value: number }) => ({ opId: o.opId, status: 'applied', type: o.type, key: o.key, value: o.value })) },
});

test("a call refused 401 after the player changed is not sent again with the new player's token (control: the same player's is)", async () => {
  for (const switched of [true, false]) {
    const server = new FakeServer();
    const { progress, store, identity } = await rig(server);
    await progress.learnKinds([{ key: 'coins', kind: 'SUM' }]);
    await progress.report('add', 'coins', 5);
    let first = true;
    server.on('POST', '/v1/me/progress', async (call) => {
      if (!first) return applyAll(call);
      first = false;
      // While A's call is on its way, another tab signs B in; then A's token is refused as expired.
      if (switched) await anotherTabSignsIn(store);
      return { status: 401, json: { error: { code: 'token_expired', message: 'x' } } };
    });
    const out = await progress.flush();
    const sent = server.calls.filter((c) => c.path === '/v1/me/progress');
    if (switched) {
      assert.equal(out.stoppedBy, 'context_changed');
      assert.deepEqual(sent.map(bearer), [A], "A's stat went only with A's token");
      assert.equal(identity.player?.subject, B);
      assert.equal(await progress.waiting(A), 1, "A's op waits, frozen, for A");
    } else {
      assert.equal(out.applied, 1);
      assert.deepEqual(sent.map(bearer), [A, A], 'refreshed and sent again for the same player');
    }
  }
});

test("a late account_merged answer for the player who left does not sign out the one who plays now (control: for the player still signed in, it does)", async () => {
  for (const switched of [true, false]) {
    const server = new FakeServer();
    const { progress, store, identity } = await rig(server);
    const changes: string[] = [];
    identity.onChange((change) => changes.push(change.type));
    await progress.learnKinds([{ key: 'coins', kind: 'SUM' }]);
    await progress.report('add', 'coins', 5);
    server.on('POST', '/v1/me/progress', async () => {
      // While A's call is on its way the player becomes B (another tab signed B in, this one took it up);
      // then A's answer arrives: A's account was merged.
      if (switched) {
        await anotherTabSignsIn(store);
        await identity.credentials(true);
      }
      return { status: 401, json: { error: { code: 'account_merged', message: 'x' }, mergedInto: 'pw_target_cccccccccccc' } };
    });
    const out = await progress.flush();
    const kept = await store.get<{ subject: string }>(TOKENS);
    assert.equal(out.stoppedBy, 'account_merged');
    assert.ok((await identity.waitingOwners()).includes(A), "A's queues wait for the merge check either way");
    if (switched) {
      assert.equal(identity.player?.subject, B, 'B plays on');
      assert.equal(kept?.subject, B, "B's tokens stay");
      assert.ok(!changes.includes('merged'), 'B is not told of a merge that was not its own');
    } else {
      assert.equal(identity.player, null, 'A, merged, is signed out');
      assert.equal(kept, undefined);
      assert.ok(changes.includes('merged'));
    }
  }
});

test("a save whose store write the player outlived is not sent with the new player's token (control: it is sent with its own)", async () => {
  for (const switched of [true, false]) {
    const server = new FakeServer();
    const gate = gatedStore((key) => key.startsWith(UPLOADS));
    const { files, identity, store } = await rig(server, gate.store);
    server.on('PUT', '/v1/apps/buried/files/save-1', (call) => ({
      status: 201,
      json: { file: { id: 'fil_aaaaaaaaaaaaaaaaaaaa', slot: 'save-1', generation: 1, uploadId: call.headers.get('idempotency-key') } },
    }));
    const saving = files.save('save-1', new Uint8Array([1, 2, 3]), { base: null });
    await gate.reached;
    if (switched) {
      await anotherTabSignsIn(store);
      await identity.accessToken(true);
      assert.equal(identity.player?.subject, B);
    }
    gate.release();
    const puts = () => server.calls.filter((c) => c.method === 'PUT');
    if (switched) {
      await assert.rejects(saving, (e: unknown) => isKrtuworksError(e, 'context_changed'));
      assert.equal(puts().length, 0, "nothing went with B's token");
      const kept = await Promise.all((await store.keys(UPLOADS)).map((k) => store.get<{ owner: string }>(k)));
      assert.deepEqual(kept.map((u) => u?.owner), [A], 'the save waits for A');
    } else {
      await saving;
      assert.deepEqual(puts().map(bearer), [A]);
    }
  }
});

test('a move cut short after the target was written and run again adds nothing twice (control: an uncut move)', async () => {
  for (const cut of [true, false]) {
    const server = new FakeServer();
    let failDelete = cut;
    const inner = memoryStore();
    const store: KrtuStore = {
      ...inner,
      async delete(key) {
        if (failDelete && key === 'krtu:buried.test.web:progress:anon') {
          failDelete = false;
          throw new Error('the app closed');
        }
        return inner.delete(key);
      },
    };
    const { progress, identity } = await rig(server, store);
    const owner = identity.player!.subject;
    await progress.learnKinds([{ key: 'coins', kind: 'SUM' }]);
    // 7 made before any account, 3 by the player.
    await store.set('krtu:buried.test.web:progress:anon', { stats: { coins: { inFlight: [], pending: [{ op: 'add', value: 7 }] } }, unlocks: {}, scores: {} });
    await progress.report('add', 'coins', 3);
    if (cut) await assert.rejects(progress.move('anon', owner));
    await progress.move('anon', owner);
    assert.equal(await progress.waiting('anon'), 0);
    const sent: number[] = [];
    const seen = new Set<string>();
    server.on('POST', '/v1/me/progress', (call) => {
      for (const o of call.json.ops) if (!seen.has(o.opId)) (seen.add(o.opId), sent.push(o.value));
      return applyAll(call);
    });
    await progress.flush();
    assert.equal(sent.reduce((a, b) => a + b, 0), 10, cut ? 'the source counted once after the cut and the second run' : 'source and target');
  }
});

test('an events move cut short and run again holds each event once and says the dropped count once', async () => {
  const server = new FakeServer();
  let failDelete = true;
  const inner = memoryStore();
  const store: KrtuStore = {
    ...inner,
    async delete(key) {
      if (failDelete && key === 'krtu:buried.test.web:events:anon') {
        failDelete = false;
        throw new Error('the app closed');
      }
      return inner.delete(key);
    },
  };
  const { events, identity } = await rig(server, store);
  const owner = identity.player!.subject;
  const event = (id: string) => ({ id, type: 'button', createdAt: new Date().toISOString(), launchId: 'l', monotonicMs: 0, data: { name: id } });
  await store.set('krtu:buried.test.web:events:anon', { pending: [event('e1'), event('e2')], batch: null, dropped: 4, reported: 0 });
  await assert.rejects(events.move('anon', owner));
  await events.move('anon', owner);
  const state = await store.get<{ pending: Array<{ id: string }>; dropped: number; reported: number }>(`krtu:buried.test.web:events:${owner}`);
  assert.deepEqual(state!.pending.map((e) => e.id), ['e1', 'e2']);
  assert.equal(state!.dropped - state!.reported, 4);
});

/** Every call fails with no answer while `offline.on`. */
function switchable(server: FakeServer): { fetch: typeof fetch; offline: { on: boolean } } {
  const offline = { on: false };
  return { offline, fetch: (input, init) => (offline.on ? Promise.reject(new TypeError('fetch failed')) : server.fetch(input, init)) };
}

/** A slot that keeps the last body it took, answering each upload id once. */
function settingsSlot(server: FakeServer) {
  const taken: string[] = [];
  const known = new Map<string, unknown>();
  server.on('PUT', '/v1/apps/buried/files/settings', (call) => {
    const id = call.headers.get('idempotency-key')!;
    if (!known.has(id)) {
      taken.push(new TextDecoder().decode(call.raw));
      known.set(id, { id: `fil_${String(taken.length).padStart(20, 'a')}`, slot: 'settings', generation: taken.length });
    }
    return { status: 201, json: { file: known.get(id) } };
  });
  server.onPrefix('GET', '/v1/apps/buried/files/settings/uploads/', (call) => {
    const id = call.path.split('/').pop()!;
    return known.has(id) ? { json: { uploadId: id, status: 'ACTIVATED', file: known.get(id) } } : { status: 404, json: { error: { code: 'upload_not_found', message: 'x' } } };
  });
  return taken;
}

test('twenty saves of one slot made offline leave two waiting, not twenty; online the newest lands last', async () => {
  const server = new FakeServer();
  const net = switchable(server);
  const { files, store } = await rig(server, memoryStore(), net.fetch);
  const taken = settingsSlot(server);
  net.offline.on = true;
  const codes: string[] = [];
  for (let i = 1; i <= 20; i += 1) {
    await files.save('settings', new TextEncoder().encode(`v${i}`)).catch((e: unknown) => codes.push(isKrtuworksError(e) ? e.code : 'x'));
  }
  assert.equal(codes.length, 20);
  assert.ok(codes.every((c) => c === 'network_error'));
  assert.equal((await store.keys(UPLOADS)).length, 2, 'the first, which was sent, and the newest; the ones between were replaced');
  net.offline.on = false;
  const out = await files.resume();
  assert.deepEqual(taken, ['v1', 'v20'], 'the earlier one (it may have arrived) settles first; the newest lands last');
  assert.deepEqual(out.map((o) => o.outcome), ['saved', 'saved']);
  assert.equal((await store.keys(UPLOADS)).length, 0);
});

test('an earlier save the server never heard of is replaced once it can no longer arrive (control: a recent one is sent again first)', async () => {
  for (const old of [true, false]) {
    const server = new FakeServer();
    const net = switchable(server);
    const { files, store } = await rig(server, memoryStore(), net.fetch);
    const taken = settingsSlot(server);
    net.offline.on = true;
    await files.save('settings', new TextEncoder().encode('v1')).catch(() => undefined);
    await files.save('settings', new TextEncoder().encode('v2')).catch(() => undefined);
    if (old) {
      for (const key of await store.keys('krtu:buried.test.web:uploadSent:')) await store.set(key, Date.now() - 16 * 60_000);
    }
    net.offline.on = false;
    const out = await files.resume();
    assert.deepEqual(taken, old ? ['v2'] : ['v1', 'v2']);
    assert.deepEqual(out.map((o) => o.outcome), old ? ['replaced', 'saved'] : ['saved', 'saved']);
  }
});

test('an earlier save with a version check the server never heard of is replaced at once: if it still came, the check would refuse it', async () => {
  const server = new FakeServer();
  const net = switchable(server);
  const { files } = await rig(server, memoryStore(), net.fetch);
  const taken: string[] = [];
  server.on('PUT', '/v1/apps/buried/files/save-1', (call) => {
    assert.equal(call.headers.get('if-none-match'), '*');
    taken.push(new TextDecoder().decode(call.raw));
    return { status: 201, json: { file: { id: 'fil_aaaaaaaaaaaaaaaaaaaa', slot: 'save-1', generation: 1 } } };
  });
  server.onPrefix('GET', '/v1/apps/buried/files/save-1/uploads/', () => ({ status: 404, json: { error: { code: 'upload_not_found', message: 'x' } } }));
  net.offline.on = true;
  await files.save('save-1', new TextEncoder().encode('v1'), { base: null }).catch(() => undefined);
  await files.save('save-1', new TextEncoder().encode('v2'), { base: null }).catch(() => undefined);
  net.offline.on = false;
  const out = await files.resume();
  assert.deepEqual(taken, ['v2'], 'the newer save goes; the older one would conflict with its own player');
  assert.deepEqual(out.map((o) => o.outcome), ['replaced', 'saved']);
});

test('waiting saves go in the order they were made, not the order of their ids', async () => {
  const server = new FakeServer();
  const { files, store } = await rig(server);
  const taken = settingsSlot(server);
  const record = (uploadId: string, text: string, savedAt: number) => ({
    uploadId,
    owner: A,
    slot: 'settings',
    device: null,
    base: null,
    conditional: false,
    sha256: 'x',
    bytes: new TextEncoder().encode(text),
    deviceInfo: null,
    savedAt,
  });
  // Written by an earlier SDK, which sent each at once: v2's id sorts (and is stored) before v1's.
  const now = Date.now();
  await store.set(`${UPLOADS}00000000-0000-4000-8000-000000000000`, record('00000000-0000-4000-8000-000000000000', 'v2', now - 1000));
  await store.set(`${UPLOADS}ffffffff-ffff-4fff-8fff-ffffffffffff`, record('ffffffff-ffff-4fff-8fff-ffffffffffff', 'v1', now - 2000));
  await files.resume();
  assert.deepEqual(taken, ['v1', 'v2'], 'the setting ends at v2');
});

test('a save started while an earlier one of the slot is in flight is replaced by a newer one, never sent after it', async () => {
  const server = new FakeServer();
  const { files, store } = await rig(server);
  const taken = settingsSlot(server);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const put = server['routes'].get('PUT /v1/apps/buried/files/settings')!;
  let reached = false;
  server.on('PUT', '/v1/apps/buried/files/settings', async (call) => {
    reached = true;
    if (!taken.length) await held;
    return put(call);
  });
  const first = files.save('settings', new TextEncoder().encode('v1'));
  while (!reached) await new Promise((r) => setTimeout(r, 5));
  const second = files.save('settings', new TextEncoder().encode('v2'));
  const third = files.save('settings', new TextEncoder().encode('v3'));
  while ((await store.keys(UPLOADS)).length < 3) await new Promise((r) => setTimeout(r, 5));
  release();
  await first;
  await assert.rejects(second, (e: unknown) => isKrtuworksError(e, 'save_replaced'));
  await third;
  assert.deepEqual(taken, ['v1', 'v3']);
});
