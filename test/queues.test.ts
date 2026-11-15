import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../src/api.js';
import { Clock } from '../src/clock.js';
import { resolveOptions } from '../src/config.js';
import { EventQueue } from '../src/events.js';
import { Identity } from '../src/identity.js';
import { ProgressQueue, foldContributions } from '../src/progress.js';
import { memoryStore } from '../src/store.js';
import { FakeServer, guestRoutes, options } from './fakeServer.js';

async function signedIn(server: FakeServer, store = memoryStore()) {
  guestRoutes(server);
  const opts = resolveOptions({ ...options(server), store });
  const clock = new Clock();
  const identity = new Identity({ opts, store, fetch: server.fetch, clock });
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const api = new Api(opts, identity, server.fetch, clock);
  const subject = () => identity.player?.subject ?? null;
  return {
    identity,
    store,
    progress: new ProgressQueue({ opts, store, api, subject }),
    events: new EventQueue({ opts, store, clock, api, subject }),
  };
}

test('folding follows the stat kind; an unknown kind folds only increases', () => {
  const vals = [
    { op: 'set' as const, value: 5 },
    { op: 'set' as const, value: 9 },
    { op: 'set' as const, value: 2 },
  ];
  assert.deepEqual(foldContributions(vals, 'MAX'), [{ op: 'set', value: 9 }]);
  assert.deepEqual(foldContributions(vals, 'MIN'), [{ op: 'set', value: 2 }]);
  assert.deepEqual(foldContributions(vals, 'LATEST'), [{ op: 'set', value: 2 }]);
  assert.deepEqual(foldContributions(vals, 'SUM'), [{ op: 'add', value: 16 }]);
  assert.deepEqual(foldContributions(vals, undefined), vals, 'values to keep wait one by one while the kind is unknown');
  assert.deepEqual(
    foldContributions([{ op: 'add', value: 1 }, { op: 'add', value: 2 }, { op: 'set', value: 7 }, { op: 'add', value: 3 }], undefined),
    [{ op: 'add', value: 3 }, { op: 'set', value: 7 }, { op: 'add', value: 3 }],
  );
  assert.deepEqual(foldContributions([{ op: 'add', value: 9e14 }, { op: 'add', value: 2e14 }], 'SUM'), [{ op: 'add', value: 9e14 }, { op: 'add', value: 2e14 }], 'a sum never passes the server limit');
});

test('progress: an op lost on the way is sent again with the same id; what came meanwhile waits folded behind it', async () => {
  const server = new FakeServer();
  const { progress } = await signedIn(server);
  await progress.learnKinds([{ key: 'coins', kind: 'SUM' }]);
  await progress.report('add', 'coins', 5);
  server.offline.add('/v1/me/progress');
  assert.equal((await progress.flush()).stoppedBy, 'network_error');
  await progress.report('add', 'coins', 2);
  await progress.report('add', 'coins', 3);
  server.offline.clear();
  progress.resetBackoff();
  const sent: Array<{ opId: string; value: number }> = [];
  server.on('POST', '/v1/me/progress', (call) => {
    const results = call.json.ops.map((op: { opId: string; key: string; value: number; type: string }) => {
      sent.push({ opId: op.opId, value: op.value });
      return { opId: op.opId, status: 'applied', type: op.type, key: op.key, value: op.value };
    });
    return { json: { results, serverTime: new Date().toISOString() } };
  });
  const out = await progress.flush();
  assert.equal(out.applied, 2);
  const lost = server.calls.find((c) => c.path === '/v1/me/progress')!.json.ops[0];
  assert.equal(sent[0]!.opId, lost.opId, 'the frozen op went again with its id');
  assert.equal(sent[0]!.value, 5, 'and its value');
  assert.equal(sent[1]!.value, 5, 'the two reports behind it went as one (2 + 3)');
  assert.notEqual(sent[1]!.opId, lost.opId);
});

test('progress: one op per stat in flight; a refusal for good ends what waits for that stat only', async () => {
  const server = new FakeServer();
  const { progress, identity } = await signedIn(server);
  await progress.learnKinds([{ key: 'best', kind: 'MAX' }, { key: 'gone', kind: 'SUM' }]);
  await progress.report('set', 'best', 10);
  await progress.report('add', 'gone', 1);
  await progress.unlock('first_win');
  let round = 0;
  server.on('POST', '/v1/me/progress', (call) => {
    round += 1;
    const keys = call.json.ops.map((o: { key: string }) => o.key).sort();
    if (round === 1) assert.deepEqual(keys, ['best', 'first_win', 'gone']);
    const results = call.json.ops.map((op: { opId: string; key: string; type: string }) =>
      op.key === 'gone'
        ? { opId: op.opId, status: 'rejected', code: 'stat_retired', type: op.type, key: op.key }
        : { opId: op.opId, status: op.key === 'best' && round > 1 ? 'duplicate' : 'applied', type: op.type, key: op.key },
    );
    return { json: { results } };
  });
  // While best's op is in flight a better score comes: it waits behind, it is not a second op.
  const first = progress.flush();
  await progress.report('set', 'best', 12);
  await progress.report('add', 'gone', 4);
  await first;
  await progress.flush();
  const owner = identity.player!.subject;
  assert.equal(await progress.waiting(owner), 0);
  assert.deepEqual(progress.refusals.map((r) => `${r.key}:${r.code}`), ['gone:stat_retired'], 'the retired stat was refused once; its later report went with it');
  const bestValues = server.calls.filter((c) => c.path === '/v1/me/progress').flatMap((c) => c.json.ops.filter((o: { key: string }) => o.key === 'best').map((o: { value: number }) => o.value));
  assert.deepEqual(bestValues, [10, 12]);
});

test('progress made before any account goes to the first player, with nothing lost', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const store = memoryStore();
  const opts = resolveOptions({ ...options(server), store });
  const clock = new Clock();
  const identity = new Identity({ opts, store, fetch: server.fetch, clock });
  const api = new Api(opts, identity, server.fetch, clock);
  const progress = new ProgressQueue({ opts, store, api, subject: () => identity.player?.subject ?? null });
  await progress.report('add', 'coins', 3);
  await progress.unlock('tutorial');
  assert.equal((await progress.flush()).stoppedBy, 'signed_out');
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await progress.move('anon', identity.player!.subject);
  assert.equal(await progress.waiting('anon'), 0);
  assert.equal(await progress.waiting(identity.player!.subject), 2);
});

test('a merge moves frozen ops with their ids (a second one for the same stat keeps its own)', async () => {
  const server = new FakeServer();
  const { progress } = await signedIn(server);
  await progress.learnKinds([{ key: 'coins', kind: 'SUM' }]);
  // The merged account's queue, as another device left it: one op frozen.
  const store = (progress as unknown as { ctx: { store: ReturnType<typeof memoryStore> } }).ctx.store;
  await store.set('krtu:buried.test.web:progress:pw_old_aaaaaaaaaaaa', { stats: { coins: { inFlight: [{ opId: 'old-op', type: 'stat', key: 'coins', value: 7 }], pending: [{ op: 'add', value: 1 }] } }, unlocks: {} });
  await progress.report('add', 'coins', 2);
  server.offline.add('/v1/me/progress');
  await progress.flush();
  server.offline.clear();
  progress.resetBackoff();
  await progress.move('pw_old_aaaaaaaaaaaa', 'pw_guest_aaaaaaaaaaaa');
  const sent: string[] = [];
  server.on('POST', '/v1/me/progress', (call) => {
    sent.push(...call.json.ops.map((o: { opId: string; value: number }) => `${o.opId === 'old-op' ? 'old-op' : 'new'}:${o.value}`));
    return { json: { results: call.json.ops.map((o: { opId: string; type: string; key: string }) => ({ opId: o.opId, status: 'applied', type: o.type, key: o.key })) } };
  });
  await progress.flush();
  assert.deepEqual(sent.slice(0, 2).sort(), ['new:2', 'old-op:7'], 'both frozen ops went, each with its own id');
  assert.deepEqual(sent.slice(2), ['new:1'], 'the waiting increase went after them');
});

test('events: a batch is frozen before its first send and sent again unchanged; retry events go in a new batch with their ids', async () => {
  const server = new FakeServer();
  const { events } = await signedIn(server);
  for (let i = 0; i < 3; i += 1) events.add({ type: 'screen_view', data: { screen: `s${i}` } });
  server.offline.add('/v1/events');
  assert.equal((await events.flush()).stoppedBy, 'network_error');
  server.offline.clear();
  events.resetBackoff();
  const bodies: any[] = [];
  server.on('POST', '/v1/events', (call) => {
    bodies.push(call.json ?? JSON.parse(new TextDecoder().decode(call.raw)));
    const body = bodies[bodies.length - 1];
    const ids = body.events.map((e: { id: string }) => e.id);
    if (bodies.length === 1) return { json: { batchId: body.batchId, accepted: ids.slice(0, 2), duplicate: [], rejected: [], retry: [{ id: ids[2], code: 'too_many_builds' }], telemetry: true } };
    return { json: { batchId: body.batchId, accepted: ids, duplicate: [], rejected: [], retry: [], telemetry: true } };
  });
  const lost = JSON.parse(new TextDecoder().decode(server.calls.find((c) => c.path === '/v1/events')!.raw));
  await events.flush();
  assert.equal(bodies[0].batchId, lost.batchId, 'the same batch id');
  assert.deepEqual(bodies[0].events, lost.events, 'the same events, byte for byte (the server hashes platform, build and events)');
  events.resetBackoff();
  await events.flush();
  assert.notEqual(bodies[1].batchId, lost.batchId, 'the retried event went in a new batch');
  assert.deepEqual(bodies[1].events.map((e: { id: string }) => e.id), [lost.events[2].id], 'with its own id');
  assert.equal(server.calls.find((c) => c.path === '/v1/events')!.headers.get('content-encoding'), 'gzip');
});

test('events: a full queue drops the oldest and says so once, as an error event', async () => {
  const server = new FakeServer();
  const { events, identity, store } = await signedIn(server);
  const owner = identity.player!.subject;
  const old = { id: 'x', type: 'button', createdAt: new Date(Date.now() - 31 * 86_400_000).toISOString(), launchId: 'l', monotonicMs: 0, data: { name: 'old' } };
  await store.set(`krtu:buried.test.web:events:${owner}`, { pending: [old], batch: null, dropped: 0, reported: 0 });
  events.add({ type: 'button', data: { name: 'new' } });
  const sent: any[] = [];
  server.on('POST', '/v1/events', (call) => {
    const body = JSON.parse(new TextDecoder().decode(call.raw));
    sent.push(...body.events);
    return { json: { batchId: body.batchId, accepted: body.events.map((e: { id: string }) => e.id), duplicate: [], rejected: [], retry: [], telemetry: true } };
  });
  await events.flush();
  assert.deepEqual(sent.map((e) => e.data?.name ?? e.data?.fingerprint), ['new', 'sdk.events_dropped'], 'the 31-day-old event went, the count was said');
  sent.length = 0;
  events.add({ type: 'button', data: { name: 'later' } });
  await events.flush();
  assert.deepEqual(sent.map((e) => e.data?.name), ['later'], 'said once');
});

test('events made before any account go to the first player', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const store = memoryStore();
  const opts = resolveOptions({ ...options(server), store });
  const clock = new Clock();
  const identity = new Identity({ opts, store, fetch: server.fetch, clock });
  const api = new Api(opts, identity, server.fetch, clock);
  const events = new EventQueue({ opts, store, clock, api, subject: () => identity.player?.subject ?? null });
  events.add({ type: 'screen_view', data: { screen: 'age' } });
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  events.add({ type: 'screen_view', data: { screen: 'menu' } });
  await events.move('anon', identity.player!.subject);
  assert.equal(await events.size('anon'), 0);
  assert.equal(await events.size(identity.player!.subject), 2);
});
