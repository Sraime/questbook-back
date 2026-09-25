import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/// Thirty seconds, six digits, SHA-1: what RFC 6238 recommends and what every
/// authenticator app assumes when a provisioning URI omits the parameters.
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;

/// One step either side. It absorbs the clock drift of a phone and the second
/// it takes to type the code; widening it further would multiply the codes
/// valid at any instant for no practical gain.
const WINDOW = 1;

/// Time-based one-time passwords, written here rather than pulled in.
///
/// It is an HMAC, a counter and a modulo — the same call this codebase already
/// makes for its token digests. `apple-verifier.ts` set the precedent: it
/// checks an RS256 signature on `node:crypto` rather than depending on a JWT
/// library for the one thing it needs.
export function generateTotpSecret(): string {
  // 20 bytes is the RFC 4226 recommendation, and a round 32 base32 characters.
  return base32Encode(randomBytes(20));
}

export function currentStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secret: string, step: number): string {
  const key = base32Decode(secret);

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', key).update(counter).digest();

  // Dynamic truncation, RFC 4226 section 5.3: the low nibble of the last byte
  // says where to read the four bytes that become the code, and the top bit is
  // dropped so the result never reads as negative.
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export interface TotpMatch {
  /// The step the code belongs to, so the caller can refuse to accept it twice.
  step: number;
}

/// Returns the matching step, or null. The caller must then check that step
/// against the last one it accepted: within its thirty seconds a code stays
/// valid, and someone who reads it over a shoulder could otherwise reuse it.
export function verifyTotp(
  secret: string,
  code: string,
  at: Date = new Date(),
): TotpMatch | null {
  if (!/^[0-9]{6}$/.test(code)) {
    return null;
  }

  const now = currentStep(at);

  for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
    const step = now + offset;
    if (constantTimeEquals(totpCode(secret, step), code)) {
      return { step };
    }
  }

  return null;
}

/// What an authenticator app scans. `issuer` appears twice by convention: in
/// the label, for apps that only read that, and as a parameter.
export function totpProvisioningUri(secret: string, login: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${login}`);
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${parameters.toString()}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }

  // No `=` padding: authenticator apps accept its absence, and every secret
  // this code generates is a multiple of five bits anyway.
  return output;
}

function base32Decode(secret: string): Buffer {
  const normalised = secret.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of normalised) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error('Invalid base32 character in TOTP secret');
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}
