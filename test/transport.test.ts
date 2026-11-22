import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from '../src/clock.js';
import { isKrtuworksError } from '../src/errors.js';
import { send } from '../src/transport.js';

const URL_ = 'https://dev.krtuworks.com/v1/me/progress';

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return isKrtuworksError(err) ? `${err.code}: ${err.message}` : String(err);
  }
  return 'answered';
}

test('a call whose answer never comes ends within its time (control: a quick answer is read)', async () => {
  let signal: AbortSignal | undefined;
  const silent: typeof fetch = (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise(() => undefined);
  };
  const started = Date.now();
  const said = await refusal(send(silent, new Clock(), URL_, { method: 'POST', timeoutMs: 50 }));
  assert.match(said, /^network_error: No answer from dev\.krtuworks\.com/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(signal?.aborted, true, 'the transport was told to stop');

  const quick: typeof fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  const answer = await send(quick, new Clock(), URL_, { method: 'POST', timeoutMs: 50 });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { ok: true });
});

test('an answer whose body stops halfway ends within the same time, and so does a transport that ignores the signal', async () => {
  const stalled: typeof fetch = async () =>
    new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"ok":')) }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.match(await refusal(send(stalled, new Clock(), URL_, { method: 'GET', timeoutMs: 50 })), /^network_error: The answer from dev\.krtuworks\.com was cut/);

  const deaf: typeof fetch = () => new Promise(() => undefined);
  assert.match(await refusal(send(deaf, new Clock(), URL_, { method: 'GET', timeoutMs: 50 })), /^network_error/);
});
