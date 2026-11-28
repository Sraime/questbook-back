import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  prisma,
  resetDatabase,
  signIn,
  type TestContext,
} from './helpers/test-app.js';
import { createTable, invite } from './helpers/tables.js';

let context: TestContext;

beforeEach(async () => {
  await resetDatabase();
  context = await createTestApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

describe('the page behind the invitation link', () => {
  async function pageFor(userAgent: string) {
    const gm = await signIn(context, 'gm');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, 'ami@example.com');
    const page = await context.app.inject({
      method: 'GET',
      url: `/invitations/${token}`,
      headers: { 'user-agent': userAgent },
    });
    return { token, page };
  }

  it('opens the app on Android, or the Play Store when it is missing', async () => {
    const { token, page } = await pageFor(ANDROID);

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`intent://invitations/${token}#Intent;scheme=questbook;`);
    expect(page.body).toContain('package=com.questbook.questbook');
    expect(page.body).toContain(
      'S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.questbook.questbook',
    );
  });

  it('offers the App Store first on an iPhone, and the app second', async () => {
    const { token, page } = await pageFor(IPHONE);

    const store = page.body.indexOf('https://apps.apple.com/app/id6813883912');
    const app = page.body.indexOf(`questbook://invitations/${token}`);
    expect(store).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(store);
  });

  it('offers both stores on a computer, and says to open the link on a phone', async () => {
    const { page } = await pageFor(DESKTOP);

    expect(page.body).toContain('apps.apple.com');
    expect(page.body).toContain('play.google.com');
    expect(page.body).toContain('depuis ton téléphone');
  });

  it('tells a used code apart from an unknown one', async () => {
    const gm = await signIn(context, 'gm');
    const player = await signIn(context, 'player');
    const table = await createTable(context, gm);
    const token = await invite(context, gm, table.id, player.email);
    await context.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/redeem',
      headers: player.authHeader,
      payload: { code: token },
    });

    const page = await context.app.inject({ method: 'GET', url: `/invitations/${token}` });

    expect(page.statusCode).toBe(409);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('déjà été utilisée');
  });
});

describe('the files phones read before trusting a link', () => {
  it('serves the Android statement as JSON for the app package', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/.well-known/assetlinks.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()[0].target.package_name).toBe('com.questbook.questbook');
  });

  it('lists well-formed SHA-256 fingerprints, without duplicates', async () => {
    // Une seule empreinte mal recopiee, et Android rejette la verification
    // sans rien en dire : le lien ouvre alors le navigateur.
    const response = await context.app.inject({
      method: 'GET',
      url: '/.well-known/assetlinks.json',
    });
    const fingerprints: string[] = response.json()[0].target.sha256_cert_fingerprints;

    expect(fingerprints.length).toBeGreaterThanOrEqual(2);
    for (const fingerprint of fingerprints) {
      expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('serves the Apple association as JSON, for invitations only', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/.well-known/apple-app-site-association',
    });

    expect(response.statusCode).toBe(200);
    // iOS ne suit aucune redirection et ignore un fichier mal type.
    expect(response.headers['content-type']).toContain('application/json');
    const [detail] = response.json().applinks.details;
    expect(detail.appIDs).toEqual(['97X67224S7.com.questbook.questbook']);
    expect(detail.components).toEqual([{ '/': '/invitations/*' }]);
  });
});
