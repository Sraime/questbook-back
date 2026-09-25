import { createHash, randomBytes } from 'node:crypto';

/// 48 bytes of randomness: unguessable, and short enough to sit in a URL.
const TOKEN_BYTES = 48;

/// The one shape of bearer secret this API issues — refresh tokens, invitation
/// links, back office sessions.
///
/// Only the digest is persisted, so a dump of the table cannot be replayed.
/// SHA-256 without a salt is deliberate and not the omission it looks like:
/// these are 48 random bytes, not passwords, so there is no dictionary to
/// precompute and nothing a work factor would buy.
export const randomToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
