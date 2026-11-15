import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newlyFixed, reportBody, screenshotType, type BugReportView } from '../src/bugs.js';
import { Krtuworks } from '../src/client.js';
import { resolveOptions } from '../src/config.js';
import { isKrtuworksError } from '../src/errors.js';
import { memoryStore } from '../src/store.js';
import { FakeServer, guestRoutes, options, type Reply } from './fakeServer.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const TERMS = { birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' };

function view(id: string, status: string, fixedIn: string | null = null): BugReportView {
  return { id, category: 'GAMEPLAY', description: 'x', platform: 'WEB', build: '1.0.0', createdAt: '2026-10-29T10:00:00Z', screenshot: false, status, fixedIn, fixedAt: null, duplicate: false };
}

function configRoute(server: FakeServer, config: Record<string, unknown> = {}) {
  server.on('GET', '/v1/apps/buried/config', () => ({ json: { appId: 'app_x', environment: 'TEST', platform: 'WEB', version: '1.0', config, switches: [], serverTime: new Date().toISOString() }, headers: { etag: '"v1"' } }));
  server.on('POST', '/v1/events', (call) => {
    const body = JSON.parse(new TextDecoder().decode(call.raw));
    return { json: { batchId: body.batchId, accepted: body.events.map((e: { id: string }) => e.id), duplicate: [], rejected: [], retry: [], telemetry: true } };
  });
  server.on('GET', '/v1/me/telemetry-opt-out', () => ({ json: { optedOut: false, updatedAt: null } }));
}

/** The server's bug endpoints: a report is kept once per reportId, its screenshot once. */
function bugRoutes(server: FakeServer, reports: Map<string, { id: string; body: any; shot: string | null }>, screenshot: () => Reply | null = () => null) {
  let seq = 0;
  server.on('POST', '/v1/me/bug-reports', (call) => {
    const known = reports.get(call.json.reportId);
    if (known) return { json: { created: false, report: { id: known.id } } };
    seq += 1;
    const id = `bug_${String(seq).padStart(20, 'a')}`;
    reports.set(call.json.reportId, { id, body: call.json, shot: null });
    return { status: 201, json: { created: true, report: { id } } };
  });
  for (let i = 1; i <= 5; i += 1) {
    server.on('PUT', `/v1/me/bug-reports/bug_${String(i).padStart(20, 'a')}/screenshot`, (call) => {
      const forced = screenshot();
      if (forced) return forced;
      const r = [...reports.values()].find((x) => call.path.includes(x.id))!;
      r.shot = call.headers.get('content-type');
      return { json: { report: { id: r.id, screenshot: true } } };
    });
  }
}

async function started(server: FakeServer, extra = {}) {
  guestRoutes(server);
  const krtu = await Krtuworks.initialize(options(server, extra));
  await krtu.refreshConfig();
  return krtu;
}

test('the picture type comes from its first bytes; anything else is not a screenshot', () => {
  assert.equal(screenshotType(PNG), 'image/png');
  assert.equal(screenshotType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(screenshotType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(screenshotType(new TextEncoder().encode('GIF89a......')), null);
});

test('a report body carries the moment and is refused at once when it can never be taken; control: a full report passes', () => {
  const opts = resolveOptions({ ...options(new FakeServer()), device: { os: 'Linux', ramMb: 8192, gpu: undefined }, locale: 'tr-TR' });
  const context = { reportId: 'r1', opts, level: 'cave/2', fps: 59.94, events: [{ type: 'death', at: 't' }], log: 'boot' };
  assert.deepEqual(reportBody({ category: 'GAMEPLAY', description: '  The door  ' }, context), {
    reportId: 'r1', category: 'GAMEPLAY', description: 'The door', platform: 'WEB', build: '1.0.0', device: { os: 'Linux', ramMb: 8192 }, locale: 'tr-TR',
    level: 'cave/2', fps: 59.9, events: [{ type: 'death', at: 't' }], log: 'boot',
  });
  const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => isKrtuworksError(e, 'invalid_request') && e.status === 400);
  refused(() => reportBody({ category: 'gameplay' as never, description: 'x' }, context));
  refused(() => reportBody({ category: 'CRASH', description: '   ' }, context));
  refused(() => reportBody({ category: 'CRASH', description: 'x'.repeat(4001) }, context));
  refused(() => reportBody({ category: 'CRASH', description: 'x', fps: 1001 }, context));
  refused(() => reportBody({ category: 'CRASH', description: 'x', position: { area: '', x: 1, y: 2 } }, context));
  refused(() => reportBody({ category: 'CRASH', description: 'x', level: 'x'.repeat(201) }, context));
  // control: what the SDK adds itself is cut to fit (the level it saw; its events, from the oldest), never refused
  const many = Array.from({ length: 50 }, (_, i) => ({ type: 'screen_view', at: String(i), data: { screen: 's'.repeat(1790) } }));
  const trimmed = reportBody({ category: 'OTHER', description: 'x' }, { ...context, level: 'l'.repeat(250), events: many }) as any;
  assert.equal(trimmed.level.length, 200);
  assert.ok(trimmed.events.length < 50 && trimmed.events.length > 40);
  assert.ok(JSON.stringify(trimmed.events).length <= 90_000);
  assert.equal(trimmed.events.at(-1).at, '49');
  // control: the player's level and frame rate win over what the SDK saw; nothing optional is sent empty
  const own = reportBody({ category: 'OTHER', description: 'x', level: 'boss', fps: 30 }, { ...context, opts: resolveOptions(options(new FakeServer())), events: [], log: '' });
  assert.deepEqual(own, { reportId: 'r1', category: 'OTHER', description: 'x', platform: 'WEB', build: '1.0.0', level: 'boss', fps: 30 });
});

test("fixes are told once; a device that never had the player's reports learns them without telling", () => {
  const reports = [view('bug_1', 'RESOLVED', '1.1'), view('bug_2', 'NEW')];
  const fresh = newlyFixed(reports, undefined);
  assert.deepEqual(fresh.fixed, []);
  assert.deepEqual(fresh.state.told, ['bug_1']);
  const madeHere = newlyFixed(reports, { told: [] });
  assert.deepEqual(madeHere.fixed.map((r) => r.id), ['bug_1']);
  const later = newlyFixed([view('bug_1', 'RESOLVED', '1.1'), view('bug_2', 'RESOLVED', '1.2')], madeHere.state);
  assert.deepEqual(later.fixed.map((r) => r.id), ['bug_2']);
});

test('a report waits on the device, goes with the last events, level, frame rate and log, then its screenshot; a lost answer sends the same report again', async () => {
  const server = new FakeServer();
  configRoute(server);
  const reports = new Map<string, { id: string; body: any; shot: string | null }>();
  bugRoutes(server, reports);
  const store = memoryStore();
  const krtu = await started(server, { store });
  await krtu.signInAsGuest(TERMS);
  await krtu.ready();
  await krtu.level.start({ world: 'cave', level: '2' });
  for (let i = 0; i < 55; i += 1) krtu.track('screen_view', { screen: `s${i}` });
  krtu.track('performance', { fps: 48.25 });
  krtu.log('loaded save 3');
  krtu.error(new Error('door stuck'));
  // Injected: the server keeps the report, its answer is lost on the way.
  const keep = server['routes'].get('POST /v1/me/bug-reports')!;
  server.on('POST', '/v1/me/bug-reports', async (call) => {
    await keep(call);
    throw new TypeError('fetch failed');
  });
  const { reportId } = await krtu.reportBug({ category: 'GAMEPLAY', description: 'The cave door does not open', screenshot: PNG.buffer.slice(0) as ArrayBuffer });
  const lost = await krtu.flush();
  assert.equal(lost.bugs.stoppedBy, 'network_error');
  assert.equal((await krtu.waiting()).bugReports, 1, 'kept on the device');
  await krtu.shutdown();
  server.on('POST', '/v1/me/bug-reports', keep);
  // The next launch sends it at the player's arrival: the same report (the server answers it is known), then its screenshot.
  const next = await Krtuworks.initialize(options(server, { store }));
  await next.ready();
  assert.equal((await next.waiting()).bugReports, 0);
  const second = await next.reportBug({ category: 'TEXT', description: 'A typo on the map' });
  assert.equal((await next.flush()).bugs.sent, 1);
  const posted = server.calls.filter((c) => c.path === '/v1/me/bug-reports' && c.method === 'POST').map((c) => c.json);
  assert.equal(posted.length, 3, 'the lost one, its resend, the second report');
  assert.deepEqual(posted[1], posted[0], 'the lost report went again exactly as made');
  assert.equal(reports.size, 2, 'The server has each report once');
  const body = reports.get(reportId)!.body;
  assert.equal(body.level, 'cave/2');
  assert.equal(body.fps, 48.3);
  assert.equal(body.events.length, 50, 'the last 50 events');
  assert.equal(body.events.at(-1).type, 'error');
  assert.match(body.log, /loaded save 3\n.*error Error: door stuck$/);
  assert.equal(reports.get(reportId)!.shot, 'image/png');
  assert.equal(reports.get(second.reportId)!.shot, null);
  await next.shutdown();
});

test('a report refused for good is dropped, one that cannot go now waits (control); a screenshot too late is let go, the report kept', async () => {
  const server = new FakeServer();
  configRoute(server);
  const reports = new Map<string, { id: string; body: any; shot: string | null }>();
  let shot: Reply | null = { status: 503, json: { error: { code: 'storage_not_ready', message: 'later' } } };
  bugRoutes(server, reports, () => shot);
  const krtu = await started(server);
  await krtu.signInAsGuest(TERMS);
  await krtu.ready();
  await krtu.reportBug({ category: 'CRASH', description: 'Crashed on load', screenshot: PNG });
  const busy = await krtu.flush();
  assert.equal(busy.bugs.stoppedBy, 'storage_not_ready');
  assert.equal(server.count('POST', '/v1/me/bug-reports'), 1);
  // The wait is in memory: the network coming back (a reset) sends it now.
  (krtu as unknown as { bugs: { resetBackoff(): void } }).bugs.resetBackoff();
  shot = { status: 409, json: { error: { code: 'screenshot_too_late', message: 'late' } } };
  const late = await krtu.flush();
  assert.equal(server.count('POST', '/v1/me/bug-reports'), 1, 'the report is in: only its screenshot was tried again');
  assert.deepEqual(late.bugs.dropped.map((d) => [d.code, d.screenshotOnly]), [['screenshot_too_late', true]]);
  assert.equal((await krtu.waiting()).bugReports, 0);
  server.on('POST', '/v1/me/bug-reports', () => ({ status: 400, json: { error: { code: 'platform_not_registered', message: 'no' } } }));
  await krtu.reportBug({ category: 'AUDIO', description: 'No sound' });
  const refused = await krtu.flush();
  assert.deepEqual(refused.bugs.dropped.map((d) => [d.code, d.screenshotOnly]), [['platform_not_registered', false]]);
  assert.equal((await krtu.waiting()).bugReports, 0);
  await krtu.shutdown();
});

test('bug reports off: refused at once and nothing kept; made before any player, a report goes with the first one', async () => {
  const off = new FakeServer();
  configRoute(off, { modules: { bugReports: false } });
  const k1 = await started(off);
  await assert.rejects(k1.reportBug({ category: 'OTHER', description: 'x' }), (e: unknown) => isKrtuworksError(e, 'module_disabled'));
  assert.equal((await k1.waiting()).bugReports, 0);
  await k1.shutdown();

  const server = new FakeServer();
  configRoute(server);
  const reports = new Map<string, { id: string; body: any; shot: string | null }>();
  bugRoutes(server, reports);
  const krtu = await started(server);
  await krtu.reportBug({ category: 'CONTROLS', description: 'The pad does nothing' });
  assert.equal((await krtu.flush()).bugs.sent, 0, 'no player yet');
  await krtu.signInAsGuest(TERMS);
  await krtu.ready();
  assert.equal(reports.size, 1, 'sent once the first player arrived');
  await krtu.shutdown();
});

test("the player's reports: a fix is told once to the game, never to no one; a device that only reads them tells nothing at first (control)", async () => {
  const server = new FakeServer();
  configRoute(server);
  bugRoutes(server, new Map());
  let list = [view('bug_old', 'RESOLVED', '0.9'), view('bug_open', 'NEW')];
  server.on('GET', '/v1/me/bug-reports', () => ({ json: { reports: list, serverTime: new Date().toISOString() } }));
  const krtu = await started(server);
  await krtu.signInAsGuest(TERMS);
  await krtu.ready();
  const told: string[] = [];
  assert.equal((await krtu.myBugReports()).length, 2, 'the first look learns what was already fixed');
  list = [view('bug_old', 'RESOLVED', '0.9'), view('bug_open', 'RESOLVED', '1.0.1')];
  await krtu.myBugReports();
  // No one listened yet: the fix waits for the next look instead of being lost.
  krtu.onBugFixed((r) => told.push(`${r.id}@${r.fixedIn}`));
  await krtu.myBugReports();
  await krtu.myBugReports();
  assert.deepEqual(told, ['bug_open@1.0.1'], 'told once, and not the fix the first look learned');

  // A device where the player reported: the next arrival checks by itself and tells the fix.
  const store = memoryStore();
  const other = new FakeServer();
  configRoute(other);
  bugRoutes(other, new Map());
  let mine = [view('bug_aaaaaaaaaaaaaaaaaaa1', 'NEW')];
  other.on('GET', '/v1/me/bug-reports', () => ({ json: { reports: mine, serverTime: new Date().toISOString() } }));
  const k2 = await started(other, { store });
  await k2.signInAsGuest(TERMS);
  await k2.ready();
  await k2.reportBug({ category: 'TEXT', description: 'Typo' });
  await k2.flush();
  await k2.shutdown();
  mine = [view('bug_aaaaaaaaaaaaaaaaaaa1', 'RESOLVED', '1.0.2')];
  const k3 = await Krtuworks.initialize(options(other, { store }));
  const toldAgain: string[] = [];
  k3.onBugFixed((r) => toldAgain.push(r.fixedIn ?? ''));
  await k3.ready();
  assert.deepEqual(toldAgain, ['1.0.2']);
  await k3.shutdown();
});

test("a player reports another player's picture by subject, with a reason from the list and a trimmed note; refused before any call when it can never be taken", async () => {
  const server = new FakeServer();
  configRoute(server);
  const seen: Array<{ path: string; body: unknown }> = [];
  server.on('POST', '/v1/players/pw_other_player/avatar-report', (call) => {
    seen.push({ path: call.path, body: call.json });
    return { json: { reported: true, already: seen.length > 1 } };
  });
  const krtu = await started(server);
  await krtu.signInAsGuest(TERMS);
  assert.deepEqual(await krtu.reportAvatar('pw_other_player', 'IMPERSONATION', '  pretends to be staff  '), { already: false });
  assert.deepEqual(seen[0].body, { reason: 'IMPERSONATION', note: 'pretends to be staff' });
  // Control: the same picture again is the server's `already`.
  assert.deepEqual(await krtu.reportAvatar('pw_other_player', 'SPAM'), { already: true });
  assert.deepEqual(seen[1].body, { reason: 'SPAM' });
  for (const [subject, reason, note] of [['', 'SPAM', undefined], ['pw_other_player', 'RUDE', undefined], ['pw_other_player', 'HATE', 'x'.repeat(301)]] as const) {
    await assert.rejects(krtu.reportAvatar(subject, reason as 'SPAM', note), (e: unknown) => isKrtuworksError(e) && e.code === 'invalid_request');
  }
  assert.equal(seen.length, 2);
  await krtu.shutdown();
});
