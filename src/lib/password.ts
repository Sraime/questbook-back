import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

// `promisify` picks the overload without options, which is the one this module
// never calls.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/// OWASP's floor for scrypt, and a couple hundred milliseconds on the VPS.
/// They are stored alongside the digest so raising them later does not
/// invalidate the passwords hashed before.
const COST = 2 ** 16;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/// `scrypt$N$r$p$salt$key`, everything but the marker in base64url.
const FORMAT = 'scrypt';

/// Password hashing for the handful of back office accounts.
///
/// `scrypt` rather than argon2 on purpose: argon2 is a native module to build
/// into the Docker image, and the difference between the two is academic for a
/// login that is rate limited, locked after five failures and reachable only
/// through an SSH tunnel. This one ships with Node.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt);

  return [
    FORMAT,
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/// Answers false rather than throwing on a malformed digest: a row someone
/// edited by hand must fail the login, not crash the route.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== FORMAT) {
    return false;
  }

  const [, cost = '', blockSize = '', parallelism = '', saltPart = '', keyPart = ''] = parts;
  const salt = Buffer.from(saltPart, 'base64url');
  const expected = Buffer.from(keyPart, 'base64url');

  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  let actual: Buffer;
  try {
    actual = await derive(password, salt, {
      cost: Number(cost),
      blockSize: Number(blockSize),
      parallelism: Number(parallelism),
      keyLength: expected.length,
    });
  } catch {
    return false;
  }

  // Same length by construction, but `timingSafeEqual` throws rather than
  // returning false when they differ, so a tampered row would 500.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface DeriveParams {
  cost: number;
  blockSize: number;
  parallelism: number;
  keyLength: number;
}

async function derive(
  password: string,
  salt: Buffer,
  params: DeriveParams = {
    cost: COST,
    blockSize: BLOCK_SIZE,
    parallelism: PARALLELISM,
    keyLength: KEY_LENGTH,
  },
): Promise<Buffer> {
  // Node's default limit is below what this cost needs, and the error it
  // raises otherwise ("memory limit exceeded") names neither of them.
  const maxmem = 256 * params.cost * params.blockSize;

  return scrypt(password, salt, params.keyLength, {
    N: params.cost,
    r: params.blockSize,
    p: params.parallelism,
    maxmem,
  });
}
