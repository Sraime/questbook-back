import {
  createPublicKey,
  createVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { unauthorized } from '../../lib/errors.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';

/// Apple rotates its signing keys without warning and documents no schedule,
/// so the set is cached for a while rather than pinned, and any unknown `kid`
/// forces an immediate refetch — see `fetchKey` below.
const KEY_CACHE_TTL_MS = 60 * 60 * 1000;

/// How much clock drift between Apple and this server is tolerated on `exp`.
/// Apple mints these tokens with a five-minute life, so anything larger would
/// widen the window meaningfully.
const CLOCK_SKEW_MS = 30 * 1000;

/// The subset of the Apple identity token payload the API cares about.
///
/// Deliberately smaller than `GoogleIdentity`: Apple puts neither a name nor a
/// picture in the token — the name is handed to the client once, at the very
/// first authorization, and never again. The client passes it along on its own.
export interface AppleIdentity {
  sub: string;
  /// Null when the account was authorized without sharing an address, which
  /// Apple allows. The caller decides what to do about it.
  email: string | null;
  emailVerified: boolean;
}

/// Abstracted for the same reason as `GoogleVerifier`: tests must be able to
/// sign someone in without minting a genuine Apple token.
export interface AppleVerifier {
  verify(identityToken: string): Promise<AppleIdentity>;
}

/// Etend `JsonWebKey` plutot que de redecrire ses champs : c'est le type que
/// `createPublicKey` attend, index signature comprise.
interface AppleJwk extends JsonWebKey {
  kid: string;
  kty: string;
  alg: string;
}

/// `clientIds` is the list of audiences a token may carry: the iOS bundle id
/// for a token minted on-device, plus any Services ID if a web flow is ever
/// added.
export function createAppleVerifier(clientIds: string[]): AppleVerifier {
  const keys = new Map<string, KeyObject>();
  let fetchedAt = 0;

  async function refreshKeys(): Promise<void> {
    const response = await fetch(APPLE_KEYS_URL);
    if (!response.ok) {
      throw unauthorized(`Apple key set is unreachable (${response.status})`);
    }

    const body = (await response.json()) as { keys?: AppleJwk[] };
    keys.clear();

    for (const jwk of body.keys ?? []) {
      // RS256 is all Apple has ever signed these with; anything else would
      // need its own verification path rather than a silent best effort.
      if (jwk.kty !== 'RSA' || jwk.alg !== 'RS256') continue;
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }

    fetchedAt = Date.now();
  }

  async function fetchKey(kid: string): Promise<KeyObject> {
    const cached = keys.get(kid);
    if (cached && Date.now() - fetchedAt < KEY_CACHE_TTL_MS) {
      return cached;
    }

    // A `kid` we have never seen is the normal shape of a key rotation, not an
    // attack: refetch once before refusing the token.
    await refreshKeys();

    const key = keys.get(kid);
    if (!key) {
      throw unauthorized('Apple identity token is signed by an unknown key');
    }
    return key;
  }

  return {
    async verify(identityToken) {
      // Sans audience attendue, tout jeton serait accepte ou tout serait
      // refuse pour la mauvaise raison. Le dire vaut mieux que les deux.
      if (clientIds.length === 0) {
        throw unauthorized('Apple sign-in is not configured on this server');
      }

      const [encodedHeader, encodedPayload, encodedSignature, ...extra] =
        identityToken.split('.');
      if (!encodedHeader || !encodedPayload || !encodedSignature || extra.length > 0) {
        throw unauthorized('Apple identity token is not a JWS');
      }

      const header = decodeSegment<{ kid?: string; alg?: string }>(encodedHeader);

      // Checked before anything else: `alg: none` and HMAC tokens are the two
      // classic ways of getting a forged JWT accepted.
      if (header.alg !== 'RS256') {
        throw unauthorized('Apple identity token is not signed with RS256');
      }
      if (!header.kid) {
        throw unauthorized('Apple identity token names no signing key');
      }

      const key = await fetchKey(header.kid);
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${encodedHeader}.${encodedPayload}`);

      if (!verifier.verify(key, Buffer.from(encodedSignature, 'base64url'))) {
        throw unauthorized('Apple identity token signature does not match');
      }

      const payload = decodeSegment<{
        iss?: string;
        aud?: string | string[];
        sub?: string;
        exp?: number;
        email?: string;
        email_verified?: boolean | string;
      }>(encodedPayload);

      if (payload.iss !== APPLE_ISSUER) {
        throw unauthorized('Apple identity token was not issued by Apple');
      }

      // A token minted for another app would otherwise sign its bearer in
      // here, signature and issuer both perfectly valid.
      const audiences = Array.isArray(payload.aud)
        ? payload.aud
        : payload.aud === undefined
          ? []
          : [payload.aud];
      if (!audiences.some((audience) => clientIds.includes(audience))) {
        throw unauthorized('Apple identity token was minted for another client');
      }

      if (typeof payload.exp !== 'number' || payload.exp * 1000 + CLOCK_SKEW_MS < Date.now()) {
        throw unauthorized('Apple identity token has expired');
      }
      if (!payload.sub) {
        throw unauthorized('Apple identity token carries no subject');
      }

      // Apple sends this claim as the string "true" as often as the boolean,
      // and a strict comparison against `true` alone silently rejects half of
      // the real tokens.
      const emailVerified =
        payload.email_verified === true || payload.email_verified === 'true';

      return {
        sub: payload.sub,
        email: payload.email ?? null,
        emailVerified,
      };
    },
  };
}

function decodeSegment<T>(segment: string): T {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
  } catch {
    throw unauthorized('Apple identity token is malformed');
  }
}
