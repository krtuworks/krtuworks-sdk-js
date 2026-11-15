const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function uuidFrom(b: Uint8Array): string {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * RFC 9562 UUIDv7: 48 bits of Unix milliseconds, then random. Event, op and batch ids are made once and
 * never again for the same thing, so an answer lost on the way is safe to ask for twice.
 */
export function uuidV7(nowMs = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ts = Math.max(0, Math.floor(nowMs));
  for (let i = 5; i >= 0; i -= 1) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return uuidFrom(b);
}

export function uuidV4(): string {
  return crypto.randomUUID();
}

export function base64(input: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < input.length; i += 0x8000) binary += String.fromCharCode(...input.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64Url(input: Uint8Array | ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256(input: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  return hex(await sha256(input));
}

/** A random URL-safe string of `bytes` random bytes (PKCE verifier, state, nonce). */
export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
