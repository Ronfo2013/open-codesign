import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ERROR_CODES } from '@open-codesign/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FacebookAdsTokenStore, type StoredFacebookAdsAuth } from './token-store';

const NOW = 1_700_000_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const createdPaths: string[] = [];

function tempPath(sub?: string): string {
  const base = join(tmpdir(), `fb-ads-token-test-${randomBytes(8).toString('hex')}`);
  const p = sub ? join(base, sub) : `${base}.json`;
  createdPaths.push(p);
  return p;
}

function baseAuth(overrides: Partial<StoredFacebookAdsAuth> = {}): StoredFacebookAdsAuth {
  return {
    schemaVersion: 1,
    accessToken: 'EAAtoken1',
    expiresAt: NOW + ONE_HOUR_MS,
    userId: 'user_123',
    updatedAt: NOW,
    ...overrides,
  };
}

function makeStore(filePath?: string, nowFn?: () => number) {
  const fp = filePath ?? tempPath();
  const store = new FacebookAdsTokenStore({ filePath: fp, now: nowFn ?? (() => NOW) });
  return { store, filePath: fp };
}

afterEach(async () => {
  while (createdPaths.length > 0) {
    const p = createdPaths.pop();
    if (!p) continue;
    try {
      await unlink(p);
    } catch {
      // ignore
    }
  }
});

describe('FacebookAdsTokenStore', () => {
  it('read() returns null when file is missing', async () => {
    const { store } = makeStore();
    expect(await store.read()).toBeNull();
  });

  it('write -> read roundtrip preserves all fields', async () => {
    const { store, filePath } = makeStore();
    const auth = baseAuth();
    await store.write(auth);

    const store2 = new FacebookAdsTokenStore({ filePath, now: () => NOW });
    const loaded = await store2.read();
    expect(loaded).toEqual(auth);
  });

  it('write uses mode 0o600', async () => {
    const { store, filePath } = makeStore();
    await store.write(baseAuth());
    if (process.platform !== 'win32') {
      const s = await stat(filePath);
      expect(s.mode & 0o777).toBe(0o600);
    }
  });

  it('write auto-creates parent directory', async () => {
    const base = join(tmpdir(), `fb-ads-token-test-${randomBytes(8).toString('hex')}`);
    const nested = join(base, 'nested', 'creds.json');
    createdPaths.push(nested);
    createdPaths.push(base);
    const store = new FacebookAdsTokenStore({ filePath: nested, now: () => NOW });
    await store.write(baseAuth());
    const body = await readFile(nested, 'utf8');
    expect(JSON.parse(body).accessToken).toBe('EAAtoken1');
  });

  it('getValidAccessToken returns token when not expired', async () => {
    const { store } = makeStore();
    await store.write(baseAuth({ expiresAt: NOW + ONE_HOUR_MS }));
    const token = await store.getValidAccessToken();
    expect(token).toBe('EAAtoken1');
  });

  it('getValidAccessToken reads from disk when cache is empty', async () => {
    const { store, filePath } = makeStore();
    await store.write(baseAuth({ expiresAt: NOW + ONE_HOUR_MS }));

    const store2 = new FacebookAdsTokenStore({ filePath, now: () => NOW });
    expect(await store2.getValidAccessToken()).toBe('EAAtoken1');
  });

  it('getValidAccessToken throws NOT_LOGGED_IN when file is missing', async () => {
    const { store } = makeStore();
    await expect(store.getValidAccessToken()).rejects.toMatchObject({
      name: 'CodesignError',
      code: ERROR_CODES.FACEBOOK_ADS_TOKEN_NOT_LOGGED_IN,
    });
  });

  it('getValidAccessToken clears file and throws NOT_LOGGED_IN when token is expired', async () => {
    const { store, filePath } = makeStore();
    await store.write(baseAuth({ expiresAt: NOW - 1 }));

    await expect(store.getValidAccessToken()).rejects.toMatchObject({
      name: 'CodesignError',
      code: ERROR_CODES.FACEBOOK_ADS_TOKEN_NOT_LOGGED_IN,
    });
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('getValidAccessToken throws when within 5-min expiry buffer', async () => {
    const { store } = makeStore();
    await store.write(baseAuth({ expiresAt: NOW + 3 * 60 * 1000 }));
    await expect(store.getValidAccessToken()).rejects.toMatchObject({
      name: 'CodesignError',
      code: ERROR_CODES.FACEBOOK_ADS_TOKEN_NOT_LOGGED_IN,
    });
  });

  it('isLoggedIn() returns true for a valid token', async () => {
    const { store } = makeStore();
    await store.write(baseAuth({ expiresAt: NOW + ONE_HOUR_MS }));
    expect(await store.isLoggedIn()).toBe(true);
  });

  it('isLoggedIn() returns false when not logged in', async () => {
    const { store } = makeStore();
    expect(await store.isLoggedIn()).toBe(false);
  });

  it('isLoggedIn() returns false for expired token', async () => {
    const { store } = makeStore();
    await store.write(baseAuth({ expiresAt: NOW - 1 }));
    expect(await store.isLoggedIn()).toBe(false);
  });

  it('clear() removes file and drops cache', async () => {
    const { store, filePath } = makeStore();
    await store.write(baseAuth());
    await store.clear();
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.getValidAccessToken()).rejects.toMatchObject({
      code: ERROR_CODES.FACEBOOK_ADS_TOKEN_NOT_LOGGED_IN,
    });
  });

  it('clear() is a no-op when file does not exist', async () => {
    const { store } = makeStore();
    await expect(store.clear()).resolves.not.toThrow();
  });

  it('read() throws FACEBOOK_ADS_TOKEN_PARSE_FAILED on malformed JSON', async () => {
    const { store, filePath } = makeStore();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{bad json', 'utf8');
    await expect(store.read()).rejects.toMatchObject({
      name: 'CodesignError',
      code: ERROR_CODES.FACEBOOK_ADS_TOKEN_PARSE_FAILED,
    });
  });

  it('read() throws FACEBOOK_ADS_TOKEN_PARSE_FAILED when schema is invalid', async () => {
    const { store, filePath } = makeStore();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ hello: 'world' }), 'utf8');
    await expect(store.read()).rejects.toMatchObject({
      name: 'CodesignError',
      code: ERROR_CODES.FACEBOOK_ADS_TOKEN_PARSE_FAILED,
    });
  });

  it('write() is atomic — no tmp files left after successful write', async () => {
    const { store, filePath } = makeStore();
    await store.write(baseAuth({ accessToken: 'clean-write' }));

    const leftovers = (await readdir(dirname(filePath))).filter((n) =>
      n.startsWith(`${filePath.split('/').pop()}.tmp.`),
    );
    expect(leftovers).toEqual([]);
  });

  it('write() cleans up tmp file when rename fails', async () => {
    const base = join(tmpdir(), `fb-ads-token-test-${randomBytes(8).toString('hex')}`);
    const filePath = join(base, 'creds');
    createdPaths.push(filePath);
    createdPaths.push(base);
    await mkdir(filePath, { recursive: true });
    await writeFile(join(filePath, 'sentinel'), 'marker', 'utf8');

    const store = new FacebookAdsTokenStore({ filePath, now: () => NOW });
    await expect(store.write(baseAuth())).rejects.toBeInstanceOf(Error);

    const sentinel = await readFile(join(filePath, 'sentinel'), 'utf8');
    expect(sentinel).toBe('marker');

    const leftovers = (await readdir(base)).filter((n) => n.includes('.tmp.'));
    expect(leftovers).toEqual([]);

    await rm(base, { recursive: true, force: true });
  });

  it('concurrent write() calls leave file in a valid state', async () => {
    const { store, filePath } = makeStore();
    const authA = baseAuth({ accessToken: 'concurrent-A' });
    const authB = baseAuth({ accessToken: 'concurrent-B' });

    await Promise.all([store.write(authA), store.write(authB)]);

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as StoredFacebookAdsAuth;
    expect(['concurrent-A', 'concurrent-B']).toContain(persisted.accessToken);

    const leftovers = (await readdir(dirname(filePath))).filter((n) =>
      n.startsWith(`${filePath.split('/').pop()}.tmp.`),
    );
    expect(leftovers).toEqual([]);
  });
});
