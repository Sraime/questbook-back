import { createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppleVerifier } from '../src/modules/auth/apple-verifier.js';

/// Ces tests sont les seuls du depot a ne toucher ni la base ni Fastify : ce
/// qui est eprouve ici est la verification cryptographique elle-meme, et elle
/// se joue entierement entre un jeton et un jeu de cles. La suite
/// d'integration, elle, passe par `FakeAppleVerifier` et ne dirait rien de ce
/// qui suit.

const CLIENT_ID = 'com.questbook.questbook';
const KID = 'test-key-1';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

interface TokenOverrides {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  /// Signe avec une autre cle que celle publiee, pour jouer la contrefacon.
  signWith?: typeof privateKey;
}

function mintToken(overrides: TokenOverrides = {}): string {
  const header = { kid: KID, alg: 'RS256', ...overrides.header };
  const payload = {
    iss: 'https://appleid.apple.com',
    aud: CLIENT_ID,
    sub: '000123.abcdef.0001',
    exp: Math.floor(Date.now() / 1000) + 300,
    email: 'joueur@privaterelay.appleid.com',
    email_verified: 'true',
    ...overrides.payload,
  };

  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(overrides.signWith ?? privateKey)
    .toString('base64url');

  return `${signingInput}.${signature}`;
}

function serveKeys(keys: JsonWebKey[] = [{ ...jwk, kid: KID, alg: 'RS256' }]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ keys }),
  })) as unknown as typeof fetch;
}

describe('Apple identity token verification', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', serveKeys());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a token Apple really signed', async () => {
    const identity = await createAppleVerifier([CLIENT_ID]).verify(mintToken());

    expect(identity.sub).toBe('000123.abcdef.0001');
    expect(identity.email).toBe('joueur@privaterelay.appleid.com');
    // Apple envoie cette revendication en chaine aussi souvent qu'en booleen.
    expect(identity.emailVerified).toBe(true);
  });

  it('reads a boolean email_verified as well as the string', async () => {
    const identity = await createAppleVerifier([CLIENT_ID]).verify(
      mintToken({ payload: { email_verified: true } }),
    );

    expect(identity.emailVerified).toBe(true);
  });

  it('reports a missing email as such rather than inventing one', async () => {
    const identity = await createAppleVerifier([CLIENT_ID]).verify(
      mintToken({ payload: { email: undefined } }),
    );

    expect(identity.email).toBeNull();
  });

  it('refuses a token minted for another app', async () => {
    // Signature et emetteur parfaitement valides : sans ce controle, le jeton
    // d'une autre app connecterait son porteur ici.
    await expect(
      createAppleVerifier([CLIENT_ID]).verify(
        mintToken({ payload: { aud: 'com.autre.app' } }),
      ),
    ).rejects.toThrow('minted for another client');
  });

  it('refuses a token from another issuer', async () => {
    await expect(
      createAppleVerifier([CLIENT_ID]).verify(
        mintToken({ payload: { iss: 'https://evil.example.com' } }),
      ),
    ).rejects.toThrow('not issued by Apple');
  });

  it('refuses an expired token', async () => {
    await expect(
      createAppleVerifier([CLIENT_ID]).verify(
        mintToken({ payload: { exp: Math.floor(Date.now() / 1000) - 600 } }),
      ),
    ).rejects.toThrow('expired');
  });

  it('refuses a token signed by someone else', async () => {
    const forged = generateKeyPairSync('rsa', { modulusLength: 2048 });

    await expect(
      createAppleVerifier([CLIENT_ID]).verify(mintToken({ signWith: forged.privateKey })),
    ).rejects.toThrow('signature does not match');
  });

  it('refuses the two classic forgeries: alg none and an HMAC token', async () => {
    const verifier = createAppleVerifier([CLIENT_ID]);

    await expect(
      verifier.verify(mintToken({ header: { alg: 'none' } })),
    ).rejects.toThrow('not signed with RS256');

    await expect(
      verifier.verify(mintToken({ header: { alg: 'HS256' } })),
    ).rejects.toThrow('not signed with RS256');
  });

  it('refuses anything that is not a JWS', async () => {
    await expect(createAppleVerifier([CLIENT_ID]).verify('pas-un-jeton')).rejects.toThrow(
      'not a JWS',
    );
  });

  it('refetches the key set when Apple rotates its keys', async () => {
    // Un `kid` absent du jeu en cache est la forme normale d'une rotation, pas
    // une attaque : le cache tient une heure, et Apple n'annonce rien.
    const rotating = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ keys: [{ ...jwk, kid: 'ancienne-cle', alg: 'RS256' }] }),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ keys: [{ ...jwk, kid: KID, alg: 'RS256' }] }),
      });
    vi.stubGlobal('fetch', rotating);

    const verifier = createAppleVerifier([CLIENT_ID]);
    // Amorce le cache sur l'ancienne cle.
    await verifier.verify(mintToken({ header: { kid: 'ancienne-cle' } }));

    await expect(verifier.verify(mintToken())).resolves.toMatchObject({
      sub: '000123.abcdef.0001',
    });
    expect(rotating).toHaveBeenCalledTimes(2);
  });

  it('refuses a token whose key Apple does not publish', async () => {
    await expect(
      createAppleVerifier([CLIENT_ID]).verify(mintToken({ header: { kid: 'inventee' } })),
    ).rejects.toThrow('unknown key');
  });

  it('caches the key set instead of fetching it on every sign-in', async () => {
    const spy = serveKeys();
    vi.stubGlobal('fetch', spy);

    const verifier = createAppleVerifier([CLIENT_ID]);
    await verifier.verify(mintToken());
    await verifier.verify(mintToken());

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses everything when no audience is configured', async () => {
    // L'etat d'un serveur ou `APPLE_CLIENT_IDS` manque encore : il doit le
    // dire, et pas se plaindre du jeton.
    await expect(createAppleVerifier([]).verify(mintToken())).rejects.toThrow(
      'not configured',
    );
  });
});
