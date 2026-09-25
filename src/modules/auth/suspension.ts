import { AppError } from '../../lib/errors.js';

/// What the four checkpoints need to know about an account. A subset of `User`
/// so that a `select` can fetch these three columns and nothing else.
export interface SuspendableUser {
  suspendedAt: Date | null;
  suspendedUntil: Date | null;
  suspensionReason: string | null;
}

/// A dated suspension expires on its own, read at each check rather than swept
/// by a background task: there is no scheduler here, and a column nobody
/// clears would keep someone out forever.
export const isSuspended = (user: SuspendableUser, at: Date = new Date()): boolean =>
  user.suspendedAt !== null && (user.suspendedUntil === null || user.suspendedUntil > at);

/// The one place this error is built.
///
/// `403` with a named code, where the rest of the API prefers discretion: a
/// `404` would be pointless here, since we are talking to the very person the
/// measure is aimed at, and letting them believe in an outage would only make
/// them come back ten times.
///
/// The reason and the end date travel because they are meant to be read. **No
/// client displays them yet** — questbook-app#150 — and until it does, a
/// suspended player is signed out of the app without a word: `/auth/me`
/// answers `403`, which `restoreSession` treats as a rejected token and
/// clears. Sending them anyway is deliberate: the server side of the contract
/// has no reason to wait for the screen that will read it.
export function suspended(user: SuspendableUser): AppError {
  return new AppError(403, 'ACCOUNT_SUSPENDED', 'Ce compte est suspendu.', {
    reason: user.suspensionReason,
    until: user.suspendedUntil?.toISOString() ?? null,
  });
}

/// Throws unless the account may still act.
export function requireNotSuspended(user: SuspendableUser, at: Date = new Date()): void {
  if (isSuspended(user, at)) {
    throw suspended(user);
  }
}
