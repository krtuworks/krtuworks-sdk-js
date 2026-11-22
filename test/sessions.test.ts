import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Api, PlayerCall } from '../src/api.js';
import { resolveOptions } from '../src/config.js';
import { SessionKeeper } from '../src/sessions.js';
import { FakeServer, options } from './fakeServer.js';

/** An Api that answers every session call and keeps what was sent. */
function sessionApi(opensFail = 0) {
  const sent: Array<{ path: string; json: any }> = [];
  let ids = 0;
  let failing = opensFail;
  const api = {
    async player(path: string, call: PlayerCall = {}) {
      sent.push({ path, json: call.json });
      if (path === '/v1/sessions') {
        if (failing > 0) {
          failing -= 1;
          throw new Error('no answer');
        }
        ids += 1;
        return { status: 201, headers: new Headers(), bytes: null, json: { session: { id: `ses_${ids}`, startedAt: new Date().toISOString() }, heartbeatSeconds: 60 } };
      }
      return { status: 200, headers: new Headers(), bytes: null, json: {} };
    },
  };
  return { api: api as unknown as Api, sent };
}

test("a session reports only its own time in use: a new one (another player, a timeout) starts from zero, not from the launch's total", async () => {
  let now = 0;
  mock.method(performance, 'now', () => now);
  try {
    let player: string | null = 'pw_a';
    const { api, sent } = sessionApi();
    const keeper = new SessionKeeper(resolveOptions(options(new FakeServer())), api, () => player);
    const beats = () => sent.filter((s) => s.path.endsWith('/heartbeat')).map((s) => s.json);

    await keeper.open();
    now = 1000_000;
    await keeper.heartbeat();
    // An hour in use, then the app goes to the background and the player changes.
    now = 3600_000;
    keeper.setForeground(false);
    player = 'pw_b';
    keeper.close();
    now = 3700_000;
    await keeper.open();
    await keeper.heartbeat();
    keeper.setForeground(true);
    now = 3760_000;
    await keeper.heartbeat();

    assert.deepEqual(beats(), [
      { activeSeconds: 1000, foreground: true },
      { activeSeconds: 0, foreground: false },
      { activeSeconds: 60, foreground: true },
    ]);
    assert.equal(keeper.activeSeconds(), 3660, 'the launch keeps its own total');
    assert.equal(keeper.sessionActiveSeconds(), 60);
    keeper.close();
  } finally {
    mock.restoreAll();
  }
});

test('an open sent again after a lost answer is the same session: its time counts from the first try', async () => {
  let now = 0;
  mock.method(performance, 'now', () => now);
  try {
    const { api, sent } = sessionApi(1);
    const keeper = new SessionKeeper(resolveOptions(options(new FakeServer())), api, () => 'pw_a');
    now = 10_000;
    await assert.rejects(keeper.open());
    now = 40_000;
    await keeper.open();
    now = 70_000;
    await keeper.heartbeat();
    const opens = sent.filter((s) => s.path === '/v1/sessions').map((s) => s.json.clientSessionId);
    assert.equal(opens.length, 2);
    assert.equal(opens[0], opens[1], 'the same clientSessionId');
    assert.deepEqual(sent.at(-1)?.json, { activeSeconds: 60, foreground: true });
    keeper.close();
  } finally {
    mock.restoreAll();
  }
});
