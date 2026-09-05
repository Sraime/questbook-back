import { OAuth2Client } from 'google-auth-library';
import { unauthorized } from '../../lib/errors.js';

/// The subset of the Google ID token payload the API cares about.
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  pictureUrl: string | null;
  locale: string | null;
}

/// Abstracted so tests can swap in a stub instead of minting real Google
/// tokens. Production wiring is `createGoogleVerifier` below.
export interface GoogleVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

export function createGoogleVerifier(clientIds: string[]): GoogleVerifier {
  const client = new OAuth2Client();

  return {
    async verify(idToken) {
      let payload;
      try {
        // Checks the signature against Google's rotating public keys, plus the
        // issuer, expiry, and that the token was minted for one of our clients.
        const ticket = await client.verifyIdToken({ idToken, audience: clientIds });
        payload = ticket.getPayload();
      } catch (cause) {
        throw unauthorized(`Invalid Google ID token: ${(cause as Error).message}`);
      }

      if (!payload?.sub) {
        throw unauthorized('Google ID token carries no subject');
      }
      if (!payload.email) {
        throw unauthorized('Google ID token carries no email');
      }
      // An unverified email would let someone register an address they do not
      // own, and later hijack it if we ever match accounts by email.
      if (payload.email_verified === false) {
        throw unauthorized('Google account email is not verified');
      }

      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified ?? false,
        displayName: payload.name ?? null,
        pictureUrl: payload.picture ?? null,
        locale: payload.locale ?? null,
      };
    },
  };
}
