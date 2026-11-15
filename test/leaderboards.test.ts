import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../src/api.js';
import { Clock } from '../src/clock.js';
import { Krtuworks } from '../src/client.js';
import { resolveOptions } from '../src/config.js';
import { isKrtuworksError } from '../src/errors.js';
import { Identity } from '../src/identity.js';
import { ProgressQueue, foldScores, type BoardRule } from '../src/progress.js';
import { memoryStore } from '../src/store.js';
import { FakeServer, guestRoutes, options } from './fakeServer.js';

async function signedIn(server: FakeServer) {
  guestRoutes(server);
  const store = memoryStore();
  const opts = resolveOptions({ ...options(server), store });
  const clock = new Clock();
  const identity = new Identity({ opts, store, fetch: server.fetch, clock });
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const api = new Api(opts, identity, server.fetch, clock);
  return { identity, progress: new ProgressQueue({ opts, store, api, subject: () => identity.player?.subject ?? null }) };
}

interface Op { opId: string; type: string; key: string; value?: number; details?: string }

/** Answers every score op with `answer(op)`; records what was sent. */
function scoreRoute(server: FakeServer, answer: (op: Op) => Record<string, unknown> = () => ({ status: 'applied' })): Op[] {
  const sent: Op[] = [];
  server.on('POST', '/v1/me/progress', (call) => {
    const results = call.json.ops.map((op: Op) => {
      sent.push(op);
      const a = answer(op);
      // Like the server: a refusal names the key but not the type, and op_id_reused neither.
      if (a.status === 'rejected') return { opId: op.opId, ...a, ...(a.code === 'op_id_reused' ? {} : { key: op.key }) };
      return { opId: op.opId, type: op.type, key: op.key, score: op.value, changed: true, ...a };
    });
    return { json: { results, serverTime: new Date().toISOString() } };
  });
  return sent;
}

const rule = (sortOrder: BoardRule['sortOrder'], uploadMethod: BoardRule['uploadMethod']): BoardRule => ({ sortOrder, uploadMethod });
const scores = (...values: number[]) => values.map((value) => ({ value }));

test('folding waiting scores: KEEP_BEST keeps the better (DESC larger, ASC smaller), FORCE_UPDATE the last', () => {
  const run = scores(5, 9, 2);
  assert.deepEqual(foldScores(run, rule('DESC', 'KEEP_BEST')), scores(9));
  assert.deepEqual(foldScores(run, rule('ASC', 'KEEP_BEST')), scores(2));
  assert.deepEqual(foldScores(run, rule('DESC', 'FORCE_UPDATE')), scores(2));
  assert.deepEqual(foldScores(run, rule('ASC', 'FORCE_UPDATE')), scores(2));
  assert.deepEqual(foldScores(scores(2, 5, 9), rule('ASC', 'FORCE_UPDATE')), scores(9), 'FORCE_UPDATE takes the last whatever the order');
  assert.deepEqual(foldScores([], rule('DESC', 'KEEP_BEST')), []);
});

test('folding waiting scores: an equal score keeps the earlier one with its details; a board not known yet folds nothing', () => {
  const equal = [{ value: 7, details: 'AQ==' }, { value: 7, details: 'Ag==' }];
  assert.deepEqual(foldScores(equal, rule('DESC', 'KEEP_BEST')), [{ value: 7, details: 'AQ==' }]);
  assert.deepEqual(foldScores(equal, rule('ASC', 'KEEP_BEST')), [{ value: 7, details: 'AQ==' }]);
  assert.deepEqual(foldScores(scores(5, 9, 2), undefined), scores(5, 9, 2), 'every score waits, in order');
});

test('scores through the queue: a board with a known rule sends one op, an unknown one sends each score in order', async () => {
  const server = new FakeServer();
  const { progress } = await signedIn(server);
  await progress.learnBoards([{ key: 'fastest', sortOrder: 'ASC', uploadMethod: 'KEEP_BEST' }, { key: 'latest', sortOrder: 'DESC', uploadMethod: 'FORCE_UPDATE' }]);
  for (const v of [9000, 7000, 8000]) await progress.submitScore('fastest', v);
  for (const v of [10, 30, 20]) await progress.submitScore('latest', v);
  for (const v of [4, 1, 3]) await progress.submitScore('mystery', v);
  const sent = scoreRoute(server);
  assert.equal((await progress.flush()).applied, 5, 'fastest 1, latest 1, mystery 3');
  const by = (key: string) => sent.filter((o) => o.key === key).map((o) => o.value);
  assert.deepEqual(by('fastest'), [7000]);
  assert.deepEqual(by('latest'), [20]);
  assert.deepEqual(by('mystery'), [4, 1, 3], 'one in flight at a time, in the order submitted');
  assert.equal(new Set(sent.map((o) => o.opId)).size, sent.length, 'every op has its own id');
  assert.ok(sent.every((o) => o.type === 'score'));
});

test('a score whose answer was lost is sent again with the same op id and applied once', async () => {
  const server = new FakeServer();
  const { progress, identity } = await signedIn(server);
  await progress.learnBoards([{ key: 'fastest', sortOrder: 'ASC', uploadMethod: 'KEEP_BEST' }]);
  await progress.submitScore('fastest', 7000, new Uint8Array([1, 2, 3]));
  server.offline.add('/v1/me/progress');
  assert.equal((await progress.flush()).stoppedBy, 'network_error');
  await progress.submitScore('fastest', 6000);
  server.offline.clear();
  progress.resetBackoff();
  const sent = scoreRoute(server);
  const out = await progress.flush();
  const lost = server.calls.find((c) => c.path === '/v1/me/progress')!.json.ops[0];
  assert.equal(out.applied, 2);
  assert.equal(sent[0]!.opId, lost.opId, 'the frozen op went again with its id');
  assert.deepEqual([sent[0]!.value, sent[0]!.details], [7000, 'AQID'], 'and its value and details (base64)');
  assert.equal(sent.filter((o) => o.opId === lost.opId).length, 1, 'it reached the server once after the loss');
  assert.equal(sent[1]!.value, 6000, 'the better score that came meanwhile waited behind it');
  assert.equal(await progress.waiting(identity.player!.subject), 0);
});

test('a refusal for good drops only what it should: a gone board drops all its scores, invalid_value only its op (control: the valid ops applied)', async () => {
  const server = new FakeServer();
  const { progress, identity } = await signedIn(server);
  for (const v of [1, 2]) await progress.submitScore('gone', v);
  await progress.submitScore('retired', 5);
  await progress.submitScore('ranged', 2_000_000);
  await progress.submitScore('ranged', 10);
  await progress.submitScore('ok', 42);
  const sent = scoreRoute(server, (op) => {
    if (op.key === 'gone') return { status: 'rejected', code: 'unknown_leaderboard' };
    if (op.key === 'retired') return { status: 'rejected', code: 'leaderboard_retired' };
    if (op.key === 'ranged' && (op.value ?? 0) > 1_000_000) return { status: 'rejected', code: 'invalid_value' };
    return { status: 'applied' };
  });
  const out = await progress.flush();
  assert.equal(await progress.waiting(identity.player!.subject), 0);
  assert.deepEqual(progress.refusals.map((r) => `${r.key}:${r.code}`), ['gone:unknown_leaderboard', 'retired:leaderboard_retired', 'ranged:invalid_value']);
  assert.deepEqual(sent.filter((o) => o.key === 'gone').map((o) => o.value), [1], 'the second score for a gone board never went');
  assert.deepEqual(sent.filter((o) => o.key === 'ranged').map((o) => o.value), [2_000_000, 10], 'the next score of the same board still went');
  assert.equal(out.applied, 2, 'ranged 10 and ok 42');
});

test('import_off and op_id_reused end only their own op (control: the next score of the board is applied)', async () => {
  const server = new FakeServer();
  const { progress, identity } = await signedIn(server);
  await progress.submitScore('board', 1);
  await progress.submitScore('board', 2);
  await progress.submitScore('board', 3);
  let n = 0;
  const sent = scoreRoute(server, () => {
    n += 1;
    return n === 1 ? { status: 'rejected', code: 'import_off' } : n === 2 ? { status: 'rejected', code: 'op_id_reused' } : { status: 'applied' };
  });
  const out = await progress.flush();
  assert.deepEqual(sent.map((o) => o.value), [1, 2, 3]);
  assert.deepEqual(progress.refusals.map((r) => r.code), ['import_off', 'op_id_reused']);
  assert.equal(out.applied, 1);
  assert.equal(await progress.waiting(identity.player!.subject), 0);
});

test('module_disabled keeps the score queued with its op id; it is applied once the module is on (control: other progress in the same batch is applied)', async () => {
  const server = new FakeServer();
  const { progress, identity } = await signedIn(server);
  await progress.learnKinds([{ key: 'coins', kind: 'SUM' }]);
  await progress.submitScore('fastest', 7000);
  await progress.report('add', 'coins', 3);
  let on = false;
  const sent = scoreRoute(server, (op) => (op.type === 'score' && !on ? { status: 'rejected', code: 'module_disabled' } : { status: 'applied' }));
  const first = await progress.flush();
  assert.equal(first.stoppedBy, 'module_disabled');
  assert.equal(first.applied, 1, 'the stat went through');
  assert.deepEqual(progress.refusals, [], 'a kept op is not a refusal');
  assert.equal(await progress.waiting(identity.player!.subject), 1);
  on = true;
  const second = await progress.flush();
  assert.equal(second.applied, 1);
  const scoreIds = sent.filter((o) => o.type === 'score').map((o) => o.opId);
  assert.ok(scoreIds.length >= 2 && new Set(scoreIds).size === 1, 'the same op id every time');
  assert.equal(await progress.waiting(identity.player!.subject), 0);
});

test('score input is checked before anything is kept (control: the edges of what is valid are kept)', async () => {
  const server = new FakeServer();
  const { progress, identity } = await signedIn(server);
  const bad: Array<[string, number, Uint8Array | undefined]> = [
    ['Bad Key', 1, undefined],
    ['board', 1.5, undefined],
    ['board', Number.NaN, undefined],
    ['board', 1e15, undefined],
    ['board', -1e15, undefined],
    ['board', 1, new Uint8Array()],
    ['board', 1, new Uint8Array(65)],
  ];
  for (const [key, value, details] of bad) await assert.rejects(progress.submitScore(key, value, details), TypeError, `${key} ${value} ${details?.length}`);
  assert.equal(await progress.waiting(identity.player!.subject), 0, 'nothing was kept');
  await progress.submitScore('a', 999_999_999_999_999);
  await progress.submitScore('b', -999_999_999_999_999, new Uint8Array(1));
  await progress.submitScore('c', 0, new Uint8Array(64).fill(255));
  assert.equal(await progress.waiting(identity.player!.subject), 3);
  const sent = scoreRoute(server);
  await progress.flush();
  assert.equal(sent.find((o) => o.key === 'c')!.details, Buffer.alloc(64, 255).toString('base64'));
  assert.equal(sent.find((o) => o.key === 'a')!.details, undefined);
});

async function client(server: FakeServer) {
  guestRoutes(server);
  server.on('GET', '/v1/apps/buried/config', () => ({ json: { appId: 'app_x', environment: 'TEST', platform: 'WEB', version: '1.0', config: {}, switches: [], serverTime: new Date().toISOString() } }));
  const krtu = await Krtuworks.initialize(options(server, { locale: 'tr' }));
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await krtu.ready();
  return krtu;
}

test('reads: the boards come with the own score and rank, the SDK learns the rules and folds from then on (control: before the read nothing folds)', async () => {
  const server = new FakeServer();
  const krtu = await client(server);
  server.on('GET', '/v1/me/leaderboards', () => ({
    json: {
      locale: 'tr',
      leaderboards: [
        { key: 'fastest', name: 'En hizli', description: null, sortOrder: 'ASC', display: 'TIME_MILLISECONDS', uploadMethod: 'KEEP_BEST', importFromPlatform: true, platformIds: { STEAM: 'fastest_run' }, score: 7000, details: null, rank: 3, entries: 12 },
        { key: 'new', name: 'New', description: null, sortOrder: 'DESC', display: 'NUMERIC', importFromPlatform: false, platformIds: {}, score: null, details: null, rank: null, entries: 0 },
      ],
      serverTime: new Date().toISOString(),
    },
  }));
  const sent = scoreRoute(server);
  server.offline.add('/v1/me/progress');
  await krtu.submitScore('fastest', 9000);
  await krtu.submitScore('fastest', 8000);
  const before = (await krtu.waiting()).progress;
  assert.equal(before, 2, 'rule not known: both wait');
  const view = await krtu.getLeaderboards();
  assert.equal(server.calls.find((c) => c.path === '/v1/me/leaderboards')!.query.get('locale'), 'tr');
  assert.deepEqual([view.leaderboards[0]!.score, view.leaderboards[0]!.rank, view.leaderboards[0]!.entries, view.leaderboards[0]!.platformIds], [7000, 3, 12, { STEAM: 'fastest_run' }]);
  assert.equal(view.leaderboards[1]!.rank, null);
  await krtu.submitScore('fastest', 6000);
  await krtu.submitScore('fastest', 6500);
  assert.equal((await krtu.waiting()).progress, 1, 'once the rule is known the next score folds what waited with it: 6000 is the best');
  server.offline.clear();
  await krtu.flush();
  assert.deepEqual(sent.map((o) => o.value), [6000]);
  await krtu.getLeaderboards({ locale: 'de' });
  assert.equal(server.calls.filter((c) => c.path === '/v1/me/leaderboards').pop()!.query.get('locale'), 'de');
  await krtu.shutdown();
});

test('reads: entries ask for the scope, limit and offset; a module that is off answers module_disabled (control: the read of a board that is on)', async () => {
  const server = new FakeServer();
  const krtu = await client(server);
  server.on('GET', '/v1/leaderboards/fastest/entries', () => ({
    json: {
      key: 'fastest', scope: 'around', sortOrder: 'ASC', display: 'TIME_MILLISECONDS', total: 2,
      entries: [{ rank: 1, subject: 'pw_a', name: 'ada', score: 6000, details: null, updatedAt: '2026-11-09T10:00:00Z', you: false }, { rank: 2, subject: 'pw_b', name: null, score: 7000, details: 'AQ==', updatedAt: '2026-11-09T10:01:00Z', you: true }],
      serverTime: new Date().toISOString(),
    },
  }));
  server.on('GET', '/v1/leaderboards/off/entries', () => ({ status: 403, json: { error: { code: 'module_disabled', message: 'The leaderboards module is off.' } } }));
  const around = await krtu.getLeaderboardEntries('fastest', { scope: 'around', limit: 2 });
  const call = server.calls.find((c) => c.path === '/v1/leaderboards/fastest/entries')!;
  assert.deepEqual([call.query.get('scope'), call.query.get('limit'), call.query.get('offset')], ['around', '2', null]);
  assert.deepEqual([around.total, around.entries[1]!.you, around.entries[1]!.name, around.entries[0]!.name], [2, true, null, 'ada']);
  await krtu.getLeaderboardEntries('fastest', { limit: 50, offset: 100 });
  const global = server.calls.filter((c) => c.path === '/v1/leaderboards/fastest/entries').pop()!;
  assert.deepEqual([global.query.get('scope'), global.query.get('limit'), global.query.get('offset')], [null, '50', '100']);
  const off = await krtu.getLeaderboardEntries('off').catch((e: unknown) => e);
  assert.ok(isKrtuworksError(off, 'module_disabled') && off.status === 403);
  await krtu.shutdown();
});

test('a refusal that names neither type nor key is matched by its op id (an achievement refusal ends the unlock; control: the stat next to it is applied)', async () => {
  const server = new FakeServer();
  const { progress, identity } = await signedIn(server);
  await progress.learnKinds([{ key: 'coins', kind: 'SUM' }]);
  await progress.unlock('gone_achievement');
  await progress.report('add', 'coins', 2);
  server.on('POST', '/v1/me/progress', (call) => ({
    json: {
      results: call.json.ops.map((op: Op) =>
        op.type === 'unlock' ? { opId: op.opId, status: 'rejected', code: 'unknown_achievement', key: op.key } : { opId: op.opId, status: 'applied', type: 'stat', key: op.key, value: 2 },
      ),
    },
  }));
  const out = await progress.flush();
  assert.equal(out.applied, 1);
  assert.deepEqual(progress.refusals, [{ type: 'unlock', key: 'gone_achievement', code: 'unknown_achievement' }]);
  assert.equal(await progress.waiting(identity.player!.subject), 0);
});
