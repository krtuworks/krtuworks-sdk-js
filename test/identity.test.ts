import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from '../src/clock.js';
import { resolveOptions } from '../src/config.js';
import { isKrtuworksError } from '../src/errors.js';
import { Identity, termsIn } from '../src/identity.js';
import { memoryStore } from '../src/store.js';
import { FakeServer, guestRoutes, options, tokenAnswer, verifyProof } from './fakeServer.js';

function identityOn(server: FakeServer, store = memoryStore()) {
  const opts = resolveOptions({ ...options(server), store });
  const clock = new Clock();
  return { identity: new Identity({ opts, store, fetch: server.fetch, clock }), store, clock };
}

test('a new guest needs the age screen; control: with it the key signs a proof the server can verify', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const { identity } = identityOn(server);
  await assert.rejects(identity.signInAsGuest(), (e: unknown) => isKrtuworksError(e, 'birth_date_required'));
  assert.equal(server.count('POST', '/oidc/token'), 0, 'nothing reached the token endpoint without the age screen');
  const player = await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  assert.equal(player.kind, 'guest');
  assert.equal(player.subject, 'pw_guest_aaaaaaaaaaaa');
  const grant = server.calls.find((c) => c.form?.get('grant_type')?.includes('device-key'))!;
  const proof = verifyProof(grant.form!.get('assertion')!);
  assert.ok(proof.ok, 'the signature verifies with the header key');
  assert.deepEqual(Object.keys(proof.header.jwk).sort(), ['crv', 'kty', 'x', 'y'], 'the header carries the public key and nothing more');
  assert.equal(proof.header.typ, 'krtu-device-key+jwt');
  assert.equal(proof.payload.purpose, 'login');
  assert.equal(proof.payload.client_id, 'buried.test.web');
  assert.equal(grant.form!.get('scope'), 'openid offline_access app:player');
  assert.equal(grant.form!.get('resource'), 'https://dev.krtuworks.com');
});

test('outdated terms come back with the documents to show', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const { identity } = identityOn(server);
  await assert.rejects(identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v0 PRIVACY:v1' }), (e: unknown) => {
    assert.ok(isKrtuworksError(e, 'terms_required'));
    assert.equal(e.details.terms, 'TERMS:v2 PRIVACY:v1');
    return true;
  });
  assert.equal(termsIn('Accept the current terms: TERMS:v1 PRIVACY:v3.'), 'TERMS:v1 PRIVACY:v3');
  assert.equal(termsIn('nothing here'), null);
});

test('a device clock an hour off still signs inside the server minute (iat from the Date header)', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const realNow = Date.now;
  Date.now = () => realNow() - 3_600_000;
  try {
    const { identity } = identityOn(server);
    await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  } finally {
    Date.now = realNow;
  }
  const grant = server.calls.find((c) => c.form?.get('grant_type')?.includes('device-key'))!;
  const { payload } = verifyProof(grant.form!.get('assertion')!);
  assert.ok(Math.abs(payload.iat - Date.now() / 1000) <= 2, `iat ${payload.iat} is the server's time`);
});

test('the same known key signs in again without the age screen (control: the guest is the same one)', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const store = memoryStore();
  const first = identityOn(server, store).identity;
  await first.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await first.signOut();
  const again = await identityOn(server, store).identity.signInAsGuest();
  assert.equal(again.subject, 'pw_guest_aaaaaaaaaaaa');
  const grants = server.calls.filter((c) => c.form?.get('grant_type')?.includes('device-key'));
  assert.equal(grants.length, 2);
  assert.equal(grants[1]!.form!.get('birth_date'), null, 'a known key sends no age answers');
});

test('two refreshes at once spend the refresh token once; both callers get the new access token', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const { identity } = identityOn(server);
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const [a, b] = await Promise.all([identity.accessToken(true), identity.accessToken(true)]);
  assert.equal(a, b);
  assert.equal(server.calls.filter((c) => c.form?.get('grant_type') === 'refresh_token').length, 1);
});

test('a second tab that already refreshed is used instead of spending the token again', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const store = memoryStore();
  const tabA = identityOn(server, store).identity;
  await tabA.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const tabB = identityOn(server, store).identity;
  await tabB.load();
  const stale = await tabA.accessToken();
  await tabB.accessToken(true);
  assert.equal(server.calls.filter((c) => c.form?.get('grant_type') === 'refresh_token').length, 1);
  // tabA still holds the old token; its forced refresh finds tabB's fresh one in the store.
  const fresh = await tabA.accessToken(true);
  assert.notEqual(fresh, stale);
  assert.equal(server.calls.filter((c) => c.form?.get('grant_type') === 'refresh_token').length, 1, 'no second refresh');
});

test('a refresh refused as account_merged signs out and keeps the player waiting for the merge check', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const { identity } = identityOn(server);
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  server.on('POST', '/oidc/token', () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'account_merged' } }));
  const changes: string[] = [];
  identity.onChange((c) => changes.push(c.type));
  await assert.rejects(identity.accessToken(true), (e: unknown) => isKrtuworksError(e, 'account_merged'));
  assert.equal(identity.player, null);
  assert.deepEqual(changes, ['merged']);
  assert.deepEqual(await identity.waitingOwners(), ['pw_guest_aaaaaaaaaaaa']);
});

test('a frozen app keeps the tokens (control: a revoked one signs a guest in again with its key)', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const { identity } = identityOn(server);
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const guestToken = server.calls.length;
  let refused = 'app_suspended';
  server.on('POST', '/oidc/token', (call) =>
    call.form!.get('grant_type') === 'refresh_token' ? { status: 400, json: { error: 'invalid_grant', error_description: refused } } : { json: tokenAnswer('pw_guest_aaaaaaaaaaaa') },
  );
  await assert.rejects(identity.accessToken(true), (e: unknown) => isKrtuworksError(e, 'invalid_grant'));
  assert.ok(identity.player, 'still signed in: the same refresh token works once the app is resumed');
  refused = 'grant request is invalid';
  await identity.accessToken(true);
  assert.ok(identity.player);
  assert.ok(server.calls.slice(guestToken).some((c) => c.path === '/oidc/device-key/challenge'), 'signed in again with the key');
});

test('a guest made in the background is not used when the player started a sign-in meanwhile', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const { identity } = identityOn(server);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  server.on('POST', '/oidc/device-key/challenge', async () => {
    await gate;
    return { json: { nonce: 'n'.repeat(43), expires_in: 60 } };
  });
  const guest = identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  await new Promise((r) => setTimeout(r, 10));
  // beginSignIn takes the same lock: bump the epoch from the store directly, as another tab would.
  const meta = await identity.meta();
  meta.epoch += 1;
  await (identity as unknown as { saveMeta(m: unknown): Promise<void> }).saveMeta(meta);
  release();
  await assert.rejects(guest, (e: unknown) => isKrtuworksError(e, 'context_changed'));
  assert.equal(identity.player, null);
});

test('sign-in: the address carries PKCE S256, consent, the resource and the guest; the callback checks state and nonce, once', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const { identity } = identityOn(server);
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const url = new URL(await identity.beginSignIn());
  const q = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://id.krtuworks.com/oidc/auth');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('resource'), 'https://dev.krtuworks.com');
  assert.match(q.get('scope')!, /offline_access/);
  assert.equal(verifyProof(q.get('krtu_guest')!).payload.purpose, 'promote', 'the guest is carried with a promote proof');
  let sentVerifier = '';
  server.on('POST', '/oidc/token', (call) => {
    sentVerifier = call.form!.get('code_verifier')!;
    return { json: tokenAnswer('pw_guest_aaaaaaaaaaaa', { nonce: q.get('nonce'), preferred_username: 'player_one' }) };
  });
  await assert.rejects(identity.completeSignIn(`https://play.example/callback?code=c&state=wrong`), (e: unknown) => isKrtuworksError(e, 'invalid_callback'));
  const changes: Array<{ type: string; promoted?: boolean }> = [];
  identity.onChange((c) => changes.push(c as { type: string; promoted?: boolean }));
  const player = await identity.completeSignIn(`https://play.example/callback?code=c&state=${q.get('state')}`);
  assert.equal(player.kind, 'account');
  assert.equal(player.username, 'player_one');
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sentVerifier))).toString('base64url');
  assert.equal(challenge, q.get('code_challenge'), 'the verifier matches the challenge');
  assert.deepEqual(changes, [{ type: 'signed_in', player, promoted: true }], 'the guest became this Krtuworks ID');
  await assert.rejects(identity.completeSignIn(`https://play.example/callback?code=c&state=${q.get('state')}`), (e: unknown) => isKrtuworksError(e, 'invalid_callback'), 'a callback works once');
});

test('an ID token with another nonce is refused (control: the right one is taken)', async () => {
  const server = new FakeServer();
  const { identity } = identityOn(server);
  const q = new URL(await identity.beginSignIn()).searchParams;
  server.on('POST', '/oidc/token', () => ({ json: tokenAnswer('pw_acct_aaaaaaaaaaaa', { nonce: 'not-it' }) }));
  await assert.rejects(identity.completeSignIn(`https://play.example/callback?code=c&state=${q.get('state')}`), (e: unknown) => isKrtuworksError(e, 'invalid_response'));
  assert.equal(identity.player, null);
  const q2 = new URL(await identity.beginSignIn()).searchParams;
  server.on('POST', '/oidc/token', () => ({ json: tokenAnswer('pw_acct_aaaaaaaaaaaa', { nonce: q2.get('nonce') }) }));
  assert.equal((await identity.completeSignIn(`https://play.example/callback?code=c&state=${q2.get('state')}`)).subject, 'pw_acct_aaaaaaaaaaaa');
});

test('signing in to another account leaves the guest waiting for the merge check (never moved on a guess)', async () => {
  const server = new FakeServer();
  guestRoutes(server);
  const { identity } = identityOn(server);
  await identity.signInAsGuest({ birthDate: '2000-01-01', acceptedTerms: 'TERMS:v1 PRIVACY:v1' });
  const q = new URL(await identity.beginSignIn()).searchParams;
  server.on('POST', '/oidc/token', () => ({ json: tokenAnswer('pw_acct_bbbbbbbbbbbb', { nonce: q.get('nonce') }) }));
  await identity.completeSignIn(`https://play.example/callback?code=c&state=${q.get('state')}`);
  assert.deepEqual(await identity.waitingOwners(), ['pw_guest_aaaaaaaaaaaa']);
});
