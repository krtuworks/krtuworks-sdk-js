import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Krtuworks } from '../src/client.js';
import type { SessionKeeper } from '../src/sessions.js';
import { FakeServer, guestRoutes, options } from './fakeServer.js';

/** A page for the browser layer: a window and a document that only dispatch events. */
function fakePage(visibilityState: 'visible' | 'hidden') {
  const g = globalThis as Record<string, unknown>;
  const doc = Object.assign(new EventTarget(), { visibilityState });
  g.window = new EventTarget();
  g.document = doc;
  return {
    doc,
    fire: (target: EventTarget, type: string, extra: Record<string, unknown> = {}) => target.dispatchEvent(Object.assign(new Event(type), extra)),
    remove: () => {
      delete g.window;
      delete g.document;
    },
  };
}

function routes(server: FakeServer) {
  guestRoutes(server);
  let ids = 0;
  server.on('GET', '/v1/apps/buried/config', () => ({ json: { appId: 'app_x', environment: 'TEST', platform: 'WEB', version: '1.0', config: {}, switches: [], serverTime: new Date().toISOString() } }));
  server.on('GET', '/v1/me/telemetry-opt-out', () => ({ json: { optedOut: false, updatedAt: null } }));
  server.on('POST', '/v1/sessions', () => {
    ids += 1;
    return { status: 201, json: { session: { id: `ses_${String(ids).padStart(20, 'a')}`, startedAt: new Date().toISOString() }, heartbeatSeconds: 60, serverTime: new Date().toISOString() } };
  });
}

test('a page back from the back-forward cache opens a session again (control: a first show, not from the cache, opens none)', async () => {
  const page = fakePage('visible');
  try {
    const server = new FakeServer();
    routes(server);
    const krtu = await Krtuworks.initialize(options(server, { sessions: true }));
    await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
    await krtu.ready();
    assert.equal(server.count('POST', '/v1/sessions'), 1);
    page.fire(window, 'pagehide', { persisted: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(server.calls.filter((c) => c.path.endsWith('/end')).length, 1, 'leaving ends the session');
    page.fire(window, 'pageshow', { persisted: false });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(server.count('POST', '/v1/sessions'), 1, 'not from the cache: nothing opens');
    page.fire(window, 'pageshow', { persisted: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.count('POST', '/v1/sessions'), 2, 'back from the cache: a new session');
    await krtu.shutdown();
  } finally {
    page.remove();
  }
});

test('a page opened in a hidden tab counts no time until it is shown; time in the cache is not counted either (control: a shown page counts)', async () => {
  let now = 0;
  mock.method(performance, 'now', () => now);
  const page = fakePage('hidden');
  try {
    const krtu = await Krtuworks.initialize(options(new FakeServer()));
    const keeper = (krtu as unknown as { sessions: SessionKeeper }).sessions;
    now += 60_000;
    assert.equal(keeper.activeSeconds(), 0, 'hidden from the start');
    page.doc.visibilityState = 'visible';
    page.fire(page.doc, 'visibilitychange');
    now += 30_000;
    assert.equal(keeper.activeSeconds(), 30, 'shown: it counts');
    page.fire(window, 'pagehide', { persisted: true });
    now += 600_000;
    page.fire(window, 'pageshow', { persisted: true });
    now += 5_000;
    assert.equal(keeper.activeSeconds(), 35, 'the time in the cache is not counted');
    await krtu.shutdown();
  } finally {
    page.remove();
    mock.restoreAll();
  }
});

test('a level in play stays open while the page waits in the back-forward cache and finishes on the way back (control: a page that goes for good quits it)', async () => {
  for (const persisted of [true, false]) {
    const page = fakePage('visible');
    try {
      const server = new FakeServer();
      routes(server);
      const sent: any[] = [];
      server.on('POST', '/v1/events', (call) => {
        const body = JSON.parse(new TextDecoder().decode(call.raw));
        sent.push(...body.events);
        return { json: { batchId: body.batchId, accepted: body.events.map((e: { id: string }) => e.id), duplicate: [], rejected: [], retry: [], telemetry: true } };
      });
      const krtu = await Krtuworks.initialize(options(server));
      await krtu.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
      await krtu.ready();
      await krtu.level.start({ level: '1-1' });
      page.fire(window, 'pagehide', { persisted });
      if (persisted) page.fire(window, 'pageshow', { persisted: true });
      krtu.level.complete(10);
      await krtu.flush();
      const actions = sent.filter((e) => e.type === 'progression').map((e) => e.data.action);
      assert.deepEqual(actions, persisted ? ['start', 'complete'] : ['start', 'quit'], persisted ? 'back from the cache' : 'gone for good');
      await krtu.shutdown();
    } finally {
      page.remove();
    }
  }
});
