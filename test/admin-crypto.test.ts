import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import {
  TOTP_STEP_SECONDS,
  currentStep,
  generateTotpSecret,
  totpCode,
  totpProvisioningUri,
  verifyTotp,
} from '../src/lib/totp.js';

/// Both are written here rather than pulled in, so both owe the suite a proof
/// that they do what the libraries would have. No database, no server.
describe('password hashing', () => {
  it('accepts the password it hashed, and nothing else', async () => {
    const stored = await hashPassword('un-mot-de-passe-assez-long');

    await expect(verifyPassword('un-mot-de-passe-assez-long', stored)).resolves.toBe(true);
    await expect(verifyPassword('un-mot-de-passe-assez-lonh', stored)).resolves.toBe(false);
    await expect(verifyPassword('', stored)).resolves.toBe(false);
  });

  it('salts, so the same password twice gives two digests', async () => {
    const first = await hashPassword('le meme mot de passe');
    const second = await hashPassword('le meme mot de passe');

    expect(first).not.toBe(second);
    await expect(verifyPassword('le meme mot de passe', second)).resolves.toBe(true);
  });

  it('carries its parameters, so raising them later keeps old digests usable', async () => {
    const stored = await hashPassword('peu importe');

    expect(stored.split('$').slice(0, 4)).toEqual(['scrypt', '65536', '8', '1']);
  });

  /// A row edited by hand must fail the login, not crash the route.
  it('answers false on a malformed digest instead of throwing', async () => {
    for (const stored of ['', 'nawak', 'scrypt$1$2$3', 'scrypt$65536$8$1$$', 'bcrypt$a$b$c$d$e']) {
      await expect(verifyPassword('peu importe', stored), stored).resolves.toBe(false);
    }
  });
});

describe('TOTP', () => {
  /// RFC 6238 appendix B, the SHA-1 vectors. The secret is the ASCII string
  /// "12345678901234567890", which is `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` in
  /// base32. Getting these right is the whole point of not using a library
  /// without checking.
  it('matches the reference vectors', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ];

    for (const [seconds, expected] of vectors) {
      const step = Math.floor(seconds / TOTP_STEP_SECONDS);
      expect(totpCode(secret, step), String(seconds)).toBe(expected);
    }
  });

  it('accepts the current code and names its step', () => {
    const secret = generateTotpSecret();
    const now = new Date();

    const match = verifyTotp(secret, totpCode(secret, currentStep(now)), now);

    expect(match).not.toBeNull();
    expect(match?.step).toBe(currentStep(now));
  });

  /// One step either side absorbs a phone's clock drift and the second it
  /// takes to type. Two steps away is another code entirely.
  it('tolerates one step of drift, and no more', () => {
    const secret = generateTotpSecret();
    const now = new Date();
    const step = currentStep(now);

    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step + 2), now)).toBeNull();
  });

  it('refuses anything that is not six digits', () => {
    const secret = generateTotpSecret();

    for (const code of ['', '12345', '1234567', 'abcdef', '12 345', '12345a']) {
      expect(verifyTotp(secret, code), code).toBeNull();
    }
  });

  it('generates a secret an authenticator app can read', () => {
    const secret = generateTotpSecret();

    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    const uri = new URL(totpProvisioningUri(secret, 'robin', 'Questbook'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe(secret);
    expect(uri.searchParams.get('issuer')).toBe('Questbook');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});
