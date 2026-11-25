import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Krtuworks } from '../src/client.js';
import { CURRENT_TERMS } from '../src/config.js';
import { KrtuworksError, isKrtuworksError } from '../src/errors.js';
import { memoryStore } from '../src/store.js';
import { KrtuworksUi, errorScreen, memoryMemory, type UiAnswer, type UiHost, type UiScreen } from '../src/ui/core.js';
import { checkBirth, dateOrder, turnsThirteen } from '../src/ui/format.js';
import { textFor, textSegments } from '../src/ui/texts.js';
import { FakeServer, guestRoutes, options, tokenAnswer } from './fakeServer.js';

const NOW = new Date('2026-06-01T12:00:00Z');

/** A host that answers each screen with the next scripted reply and records what it was shown. */
function scripted(replies: Array<(screen: UiScreen) => UiAnswer>, reminder: 'link' | 'later' = 'later') {
  const shown: UiScreen[] = [];
  let reminders = 0;
  const host: UiHost = {
    show(screen) {
      shown.push(screen);
      const next = replies.shift();
      if (!next) throw new Error(`no reply scripted for the ${screen.kind} screen`);
      return { answer: Promise.resolve(next(screen)), close: () => undefined };
    },
    remind() {
      reminders += 1;
      return { answer: Promise.resolve(reminder), close: () => undefined };
    },
  };
  return { host, shown, reminders: () => reminders };
}

const birth = (year: number, month: number, day: number, accepted = true) => (): UiAnswer => ({ kind: 'birth', year, month, day, accepted });

function configRoute(server: FakeServer, config: Record<string, unknown>) {
  server.on('GET', '/v1/apps/buried/config', () => ({ json: { appId: 'app_x', environment: 'TEST', platform: 'WEB', version: '1.0', config, switches: [], serverTime: new Date().toISOString() }, headers: { etag: '"v1"' } }));
}

const guestGrants = (server: FakeServer) => server.calls.filter((c) => c.path === '/oidc/token' && c.form?.get('grant_type') === 'urn:krtuworks:params:oauth:grant-type:device-key');

async function start(server: FakeServer, store = memoryStore()) {
  configRoute(server, {});
  return Krtuworks.initialize(options(server, { store }));
}

test('a new guest answers the age screen once; control: the next launch on this device shows nothing', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const store = memoryStore();
  const krtu = await start(server, store);
  const first = scripted([birth(2000, 1, 1)]);
  const result = await new KrtuworksUi(krtu, first.host, { now: () => NOW, locale: 'en-GB' }).ensurePlayer();
  assert.equal(result.status, 'signedIn');
  assert.deepEqual(first.shown.map((s) => s.kind), ['age']);
  const age = first.shown[0] as Extract<UiScreen, { kind: 'age' }>;
  assert.equal(age.order, 'dmy', 'en-GB writes the day first');
  assert.equal(age.years[0], 2026);
  assert.equal(guestGrants(server).at(-1)!.form!.get('birth_date'), '2000-01-01');
  assert.equal(guestGrants(server).at(-1)!.form!.get('accepted_terms'), CURRENT_TERMS);
  await krtu.shutdown();

  const again = await start(server, store);
  const second = scripted([]);
  assert.equal((await new KrtuworksUi(again, second.host, { now: () => NOW }).ensurePlayer()).status, 'signedIn');
  assert.equal(second.shown.length, 0, 'the device key is known: no age screen');
  await again.shutdown();
});

test('under 13 plays offline, nothing goes to the server and the answer holds until the 13th birthday; control: after it the age screen comes back', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const krtu = await start(server);
  const memory = memoryMemory();
  const child = scripted([birth(2016, 3, 14), () => ({ kind: 'offline' })]);
  const result = await new KrtuworksUi(krtu, child.host, { now: () => NOW, memory }).ensurePlayer();
  assert.deepEqual(result, { status: 'offline', reason: 'underage' });
  assert.deepEqual(child.shown.map((s) => s.kind), ['age', 'underage']);
  assert.equal(guestGrants(server).length, 0, 'no guest asked for');
  assert.equal(memory.get('krtu:ui:underageUntil'), '2029-03-14');

  const later = scripted([]);
  assert.deepEqual(await new KrtuworksUi(krtu, later.host, { now: () => new Date('2028-12-31T12:00:00Z'), memory }).ensurePlayer(), { status: 'offline', reason: 'underage' });
  assert.equal(later.shown.length, 0, 'not asked again, so the date cannot be changed');

  const grown = scripted([birth(2016, 3, 14)]);
  assert.equal((await new KrtuworksUi(krtu, grown.host, { now: () => new Date('2029-03-14T12:00:00Z'), memory }).ensurePlayer()).status, 'signedIn');
  assert.deepEqual(grown.shown.map((s) => s.kind), ['age']);
  await krtu.shutdown();
});

test('an impossible date and unticked terms ask again with the reason; control: the corrected answer goes through', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const krtu = await start(server);
  const host = scripted([birth(2000, 2, 30), birth(2000, 2, 10, false), birth(2000, 2, 10)]);
  assert.equal((await new KrtuworksUi(krtu, host.host, { now: () => NOW }).ensurePlayer()).status, 'signedIn');
  assert.deepEqual(host.shown.map((s) => (s.kind === 'age' ? s.problem : s.kind)), [null, 'invalid', 'accept']);
  assert.equal(guestGrants(server).length, 1, 'only the good answer was sent');
  await krtu.shutdown();
});

test('newer terms on the server are shown and accepted as the server names them; control: a server that keeps refusing ends on an error, not a loop', async () => {
  for (const accepts of [true, false]) {
    const server = new FakeServer();
    guestRoutes(server);
    server.on('POST', '/oidc/token', (call) => {
      if (accepts && call.form!.get('accepted_terms') === 'TERMS:v2 PRIVACY:v1') return { json: tokenAnswer('pw_guest_aaaaaaaaaaaa') };
      return { status: 400, json: { error: 'terms_required', error_description: 'Accept the current terms: TERMS:v2 PRIVACY:v1.' } };
    });
    const krtu = await start(server);
    const replies: Array<(s: UiScreen) => UiAnswer> = [birth(2000, 1, 1), () => ({ kind: 'accept' })];
    if (!accepts) replies.push(() => ({ kind: 'continue' }));
    const host = scripted(replies);
    const result = await new KrtuworksUi(krtu, host.host, { now: () => NOW }).ensurePlayer();
    assert.deepEqual(host.shown.map((s) => s.kind), accepts ? ['age', 'terms'] : ['age', 'terms', 'error']);
    assert.equal(result.status, accepts ? 'signedIn' : 'offline');
    assert.deepEqual(guestGrants(server).map((c) => c.form!.get('accepted_terms')), [CURRENT_TERMS, 'TERMS:v2 PRIVACY:v1']);
    await krtu.shutdown();
  }
});

test('no connection: Try again asks once more; control: Keep playing goes on offline', async () => {
  for (const reply of ['retry', 'continue'] as const) {
    const server = new FakeServer();
    guestRoutes(server);
    const krtu = await start(server);
    server.offline.add('/oidc/device-key/challenge');
    const host = scripted([
      birth(2000, 1, 1),
      (screen) => {
        assert.equal(screen.kind === 'error' && screen.retry, true);
        server.offline.delete('/oidc/device-key/challenge');
        return { kind: reply };
      },
    ]);
    const result = await new KrtuworksUi(krtu, host.host, { now: () => NOW }).ensurePlayer();
    assert.equal(result.status, reply === 'retry' ? 'signedIn' : 'offline');
    await krtu.shutdown();
  }
});

test('the server saying under 13 when this device thinks 13 (clocks apart): remembered at least until tomorrow', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  server.on('POST', '/oidc/token', () => ({ status: 400, json: { error: 'too_young', error_description: 'Krtuworks ID is for people aged 13 or older.' } }));
  const krtu = await start(server);
  const memory = memoryMemory();
  const host = scripted([birth(2013, 6, 1), () => ({ kind: 'offline' })]);
  assert.deepEqual(await new KrtuworksUi(krtu, host.host, { now: () => NOW, memory }).ensurePlayer(), { status: 'offline', reason: 'underage' });
  assert.deepEqual(host.shown.map((s) => s.kind), ['age', 'underage']);
  assert.equal(memory.get('krtu:ui:underageUntil'), '2026-06-02');
  await krtu.shutdown();
});

test('maintenance stops before any guest is asked for and shows the owner\'s message; control: no gate, the age screen', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  configRoute(server, { maintenance: { enabled: true, message: 'Back at 18:00 UTC.' } });
  const krtu = await Krtuworks.initialize(options(server));
  await krtu.refreshConfig();
  const host = scripted([() => ({ kind: 'continue' })]);
  assert.deepEqual(await new KrtuworksUi(krtu, host.host, { now: () => NOW }).ensurePlayer(), { status: 'offline', reason: 'unavailable' });
  assert.deepEqual(host.shown, [{ kind: 'error', message: 'Back at 18:00 UTC.', retry: false }]);
  assert.equal(guestGrants(server).length, 0);
  await krtu.shutdown();

  const open = new FakeServer();
  guestRoutes(open);
  configRoute(open, { maintenance: { enabled: false, message: 'Back at 18:00 UTC.' } });
  const again = await Krtuworks.initialize(options(open));
  await again.refreshConfig();
  const control = scripted([birth(2000, 1, 1)]);
  assert.equal((await new KrtuworksUi(again, control.host, { now: () => NOW }).ensurePlayer()).status, 'signedIn');
  assert.deepEqual(control.shown.map((s) => s.kind), ['age']);
  await again.shutdown();
});

test('error sentences: ban with reason and end, ban without, no connection, too many guests', () => {
  const ban = errorScreen(new KrtuworksError('sanctioned', 'x', 403, null, { reason: 'Cheating in ranked games.', endsAt: '2026-07-01T00:00:00Z' }), {}, 'en-GB');
  assert.deepEqual(ban, { message: "You can't play this game online: Cheating in ranked games. This ends on 1 July 2026.", retry: false });
  assert.equal(errorScreen(new KrtuworksError('sanctioned', 'x', 403), {}, 'en').message, "You can't play this game online.");
  assert.deepEqual(errorScreen(new KrtuworksError('network_error', 'x'), {}, 'en'), { message: textFor({}, 'error.offline'), retry: true });
  assert.equal(errorScreen(new KrtuworksError('guest_capacity', 'x', 503), {}, 'en').message, textFor({}, 'error.busy'));
  assert.equal(errorScreen(new Error('boom'), { 'error.generic': 'Bir şey ters gitti.' }, 'tr').message, 'Bir şey ters gitti.', 'the game\'s own sentence wins');
});

test('another device saved first: both saves are shown, the newer marked; keeping the other hands its bytes back; control: keeping this one saves over it', async () => {
  for (const keep of [1, 0] as const) {
    const server = new FakeServer();
    guestRoutes(server);
    const theirs = { id: 'fil_bbbbbbbbbbbbbbbbbbbb', slot: 'save-1', device: null, generation: 4, sizeBytes: 3, sha256: '', platform: 'STEAM', build: '1.0.0', savedAt: '2026-06-01T11:00:00Z', fromMerge: false };
    const bases: Array<string | null> = [];
    server.on('GET', '/v1/apps/buried/files/save-1', () => ({ body: new Uint8Array([9, 9, 9]), headers: { etag: `"${theirs.id}"`, 'x-krtu-generation': '4', 'x-krtu-saved-at': theirs.savedAt } }));
    server.on('PUT', '/v1/apps/buried/files/save-1', (call) => {
      bases.push(call.headers.get('if-match'));
      if (call.headers.get('if-match') !== theirs.id) return { status: 409, json: { error: { code: 'file_conflict', message: 'x' }, current: theirs } };
      return { status: 201, json: { file: { ...theirs, id: 'fil_cccccccccccccccccccc', generation: 5 } } };
    });
    const krtu = await start(server);
    await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: CURRENT_TERMS });
    await krtu.ready();
    const host = scripted([() => ({ kind: 'keep', card: keep })]);
    const ui = new KrtuworksUi(krtu, host.host, { now: () => NOW, locale: 'en-GB', describeSave: (_slot, bytes) => ({ title: bytes[0] === 9 ? 'Chapter 2' : 'Chapter 3' }) });
    const result = await ui.save('save-1', new Uint8Array([1, 2]), { base: 'fil_aaaaaaaaaaaaaaaaaaaa', name: 'Slot 1' });
    const screen = host.shown[0] as Extract<UiScreen, { kind: 'conflict' }>;
    assert.equal(screen.slot, 'Slot 1');
    assert.deepEqual(screen.cards.map((c) => [c.label, c.newer, c.summary?.title, c.when]), [
      ['This device', true, 'Chapter 3', 'Today, 12:00'],
      ['Another device · Steam', false, 'Chapter 2', 'Today, 11:00'],
    ]);
    if (keep === 1) {
      assert.equal(result.kept, 'there');
      assert.deepEqual(result.kept === 'there' && Array.from(result.bytes), [9, 9, 9]);
      assert.equal(bases.length, 1, 'nothing saved over the other device');
    } else {
      assert.equal(result.kept, 'here');
      assert.equal(bases.at(-1), theirs.id, 'saved over the version the player saw');
    }
    await krtu.shutdown();
  }
});

test('the player signs out while the conflict screen is open: nothing is returned or saved and the call ends context_changed; control: the same player gets the chosen bytes', async () => {
  for (const changes of [true, false]) {
    const server = new FakeServer();
    guestRoutes(server);
    const theirs = { id: 'fil_bbbbbbbbbbbbbbbbbbbb', slot: 'save-1', device: null, generation: 4, sizeBytes: 3, sha256: '', platform: 'STEAM', build: '1.0.0', savedAt: '2026-06-01T11:00:00Z', fromMerge: false };
    let writes = 0;
    server.on('GET', '/v1/apps/buried/files/save-1', () => ({ body: new Uint8Array([9, 9, 9]), headers: { etag: `"${theirs.id}"`, 'x-krtu-generation': '4', 'x-krtu-saved-at': theirs.savedAt } }));
    server.on('PUT', '/v1/apps/buried/files/save-1', () => {
      writes += 1;
      return { status: 201, json: { file: theirs } };
    });
    const krtu = await start(server);
    await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: CURRENT_TERMS });
    await krtu.ready();
    for (const card of [1, 0] as const) {
      const host: UiHost = {
        show: () => ({ answer: (changes ? krtu.signOut() : Promise.resolve()).then((): UiAnswer => ({ kind: 'keep', card })), close: () => undefined }),
        remind: () => ({ answer: Promise.resolve('later' as const), close: () => undefined }),
      };
      const ui = new KrtuworksUi(krtu, host, { now: () => NOW, locale: 'en-GB' });
      const run = ui.chooseSave({ slot: 'save-1', bytes: new Uint8Array([1, 2]), current: theirs });
      if (changes) {
        await assert.rejects(run, (err) => isKrtuworksError(err) && err.code === 'context_changed');
        break;
      }
      const result = await run;
      assert.equal(result.kept, card === 1 ? 'there' : 'here');
    }
    assert.equal(writes, changes ? 0 : 1, changes ? 'nothing saved for the other player' : 'keeping this one saved once');
    await krtu.shutdown();
  }
});

test('after a merge each slot with two versions asks which to keep and keeps it; control: a slot with one version is not asked about', async () => {
  for (const keep of [1, 0] as const) {
    const server = new FakeServer();
    guestRoutes(server);
    const version = (id: string, savedAt: string) => ({ id, slot: 'save-1', device: null, generation: 1, sizeBytes: 4, sha256: '', platform: 'WINDOWS', build: '1.0.0', savedAt, fromMerge: false });
    const mine = version('fil_aaaaaaaaaaaaaaaaaaaa', '2026-05-30T10:00:00Z');
    const merged = { ...version('fil_bbbbbbbbbbbbbbbbbbbb', '2026-05-31T10:00:00Z'), fromMerge: true };
    server.on('GET', '/v1/apps/buried/files', () => ({ json: { slots: [
      { key: 'save-1', kind: 'SAVE', name: 'Slot 1', retired: false, file: mine, conflict: merged, devices: [] },
      { key: 'save-2', kind: 'SAVE', name: 'Slot 2', retired: false, file: version('fil_cccccccccccccccccccc', '2026-05-29T10:00:00Z'), conflict: null, devices: [] },
    ], limits: {} } }));
    server.on('GET', '/v1/apps/buried/files/save-1', () => ({ body: new Uint8Array([1, 1, 1, 1]), headers: { etag: `"${mine.id}"` } }));
    let resolved: unknown = null;
    server.on('POST', '/v1/apps/buried/files/save-1/resolve', (call) => {
      resolved = call.json;
      return { json: { file: call.json.keep === merged.id ? merged : mine } };
    });
    const krtu = await start(server);
    await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: CURRENT_TERMS });
    const host = scripted([() => ({ kind: 'keep', card: keep })]);
    const out = await new KrtuworksUi(krtu, host.host, { now: () => NOW, locale: 'en-GB' }).resolveMergedSaves();
    const screen = host.shown[0] as Extract<UiScreen, { kind: 'conflict' }>;
    assert.equal(host.shown.length, 1, 'Slot 2 has one version: not asked');
    assert.deepEqual(screen.cards.map((c) => [c.label, c.newer]), [['Current save', false], ['From your other account', true]]);
    assert.deepEqual(resolved, { keep: keep === 1 ? merged.id : mine.id, current: mine.id });
    assert.deepEqual(out, [{ slot: 'save-1', kept: keep === 1 ? merged : mine }]);
    await krtu.shutdown();
  }
});

test('a guest\'s link reminder shows the corner prompt; Later leaves it; control: an account is never reminded', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const krtu = await start(server);
  await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: CURRENT_TERMS });
  const host = scripted([]);
  const ui = new KrtuworksUi(krtu, host.host, { now: () => NOW });
  await ui.remind();
  assert.equal(host.reminders(), 1);
  await krtu.signOut();
  await ui.remind();
  assert.equal(host.reminders(), 1, 'nobody is a guest now');
  ui.dispose();
  await krtu.shutdown();
});

test('a page address with its own code and state is left alone; control: the SDK\'s own sign-in return is finished and cleaned', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const krtu = await start(server);
  const replaced: string[] = [];
  const page = (href: string) => ({ location: { href }, history: { state: null, replaceState: (_s: unknown, _t: string, url: URL) => replaced.push(String(url)) } });
  const g = globalThis as unknown as { window?: unknown };
  try {
    g.window = page('https://play.example/?code=theirs&state=theirs');
    const host = scripted([birth(2000, 1, 1)]);
    assert.equal((await new KrtuworksUi(krtu, host.host, { now: () => NOW }).ensurePlayer()).status, 'signedIn');
    assert.deepEqual(host.shown.map((s) => s.kind), ['age']);
    assert.equal(replaced.length, 0, 'their address is untouched');

    const q = new URL(await krtu.signInUrl()).searchParams;
    server.on('POST', '/oidc/token', () => ({ json: tokenAnswer('pw_acct_aaaaaaaaaaaa', { nonce: q.get('nonce'), preferred_username: 'player_one' }) }));
    g.window = page(`https://play.example/callback?code=c&state=${q.get('state')}&keep=1`);
    const back = scripted([]);
    const result = await new KrtuworksUi(krtu, back.host, { now: () => NOW }).ensurePlayer();
    assert.equal(result.status === 'signedIn' && result.player.username, 'player_one');
    assert.deepEqual(replaced, ['https://play.example/callback?keep=1']);
  } finally {
    delete g.window;
    await krtu.shutdown();
  }
});

test('formats: date order by place, the age rule, the 13th birthday, sentences with marks', () => {
  assert.equal(dateOrder('en-US'), 'mdy');
  assert.equal(dateOrder('ja'), 'ymd');
  assert.equal(dateOrder('zh-Hant-TW'), 'ymd');
  assert.equal(dateOrder('tr-TR'), 'dmy');
  assert.equal(checkBirth(2013, 6, 1, NOW), 'ok', 'exactly 13 today');
  assert.equal(checkBirth(2013, 6, 2, NOW), 'underage', 'control: 13 tomorrow');
  assert.equal(checkBirth(2027, 1, 1, NOW), 'invalid', 'not born yet');
  assert.equal(checkBirth(1900, 1, 1, NOW), 'invalid', 'more than 120 years');
  assert.equal(turnsThirteen('2012-02-29'), '2025-03-01');
  assert.deepEqual(textSegments({}, 'age.accept'), ['I accept the ', { mark: 'terms' }, ' and the ', { mark: 'privacy' }, '.']);
});
