import { base64Url, sha256 } from './ids.js';

/** The four members of a P-256 public key, exactly what the server accepts in a proof's header. */
export interface PublicDeviceKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/**
 * The device's own key: a P-256 pair made here, the private half non-extractable,
 * kept in the store as a CryptoKey. A guest's account is bound to it; it never leaves the device.
 */
export interface DeviceKey {
  privateKey: CryptoKey;
  publicJwk: PublicDeviceKey;
  /** RFC 7638 thumbprint (SHA-256, base64url) of the public key. */
  thumbprint: string;
}

export type ProofPurpose = 'login' | 'promote' | 'delete' | 'cancel_deletion' | 'export_download';

export async function jwkThumbprint(jwk: PublicDeviceKey): Promise<string> {
  // RFC 7638: the required members only, in lexicographic order, no whitespace.
  return base64Url(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

export async function createDeviceKey(): Promise<DeviceKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('the platform made no P-256 public key');
  const publicJwk: PublicDeviceKey = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  return { privateKey: pair.privateKey, publicJwk, thumbprint: await jwkThumbprint(publicJwk) };
}

/**
 * The compact JWS a device-key call carries: header `{ alg: ES256, typ: krtu-device-key+jwt, jwk }`,
 * claims `{ nonce, client_id, purpose, key_thumbprint, iat }`. WebCrypto's ECDSA signature is already the
 * raw r||s form JWS wants. `iat` is the server's clock as far as it is known: a device whose clock is
 * off still signs inside the server's minute.
 */
export async function signProof(key: DeviceKey, claims: { nonce: string; clientId: string; purpose: ProofPurpose; iat: number }): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'ES256', typ: 'krtu-device-key+jwt', jwk: key.publicJwk }));
  const payload = base64Url(
    JSON.stringify({ nonce: claims.nonce, client_id: claims.clientId, purpose: claims.purpose, key_thumbprint: key.thumbprint, iat: claims.iat }),
  );
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64Url(signature)}`;
}
