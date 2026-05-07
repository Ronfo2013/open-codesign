import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADS_SCOPES,
  AUTH_BASE,
  CLIENT_ID,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserId,
  generatePkce,
} from './oauth';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('generatePkce', () => {
  it('produces a base64url verifier of at least 43 chars', () => {
    const { verifier } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('challenge equals base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('generates unique pairs on each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('buildAuthorizeUrl', () => {
  it('contains all required params and default client_id', () => {
    const url = buildAuthorizeUrl({
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 'state-xyz',
      challenge: 'chal-abc',
    });
    expect(url.startsWith(`${AUTH_BASE}/dialog/oauth?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(params.get('scope')).toBe(ADS_SCOPES);
    expect(params.get('code_challenge')).toBe('chal-abc');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('state')).toBe('state-xyz');
  });

  it('respects custom clientId override', () => {
    const url = buildAuthorizeUrl({
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 's',
      challenge: 'c',
      clientId: 'my-custom-app-id',
    });
    expect(new URL(url).searchParams.get('client_id')).toBe('my-custom-app-id');
  });
});

describe('exchangeCode', () => {
  it('fetches with correct query params and parses response', async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    let capturedUrl = '';
    const fetchMock = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ access_token: 'EAAat', expires_in: 3600, token_type: 'bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await exchangeCode('thecode', 'theverifier', 'http://localhost:1455/cb');

    const parsedUrl = new URL(capturedUrl);
    expect(parsedUrl.searchParams.get('grant_type')).toBe('authorization_code');
    expect(parsedUrl.searchParams.get('code')).toBe('thecode');
    expect(parsedUrl.searchParams.get('redirect_uri')).toBe('http://localhost:1455/cb');
    expect(parsedUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(parsedUrl.searchParams.get('code_verifier')).toBe('theverifier');

    expect(result).toEqual({
      accessToken: 'EAAat',
      expiresAt: now + 3600 * 1000,
      userId: null,
    });
  });

  it('uses custom clientId when provided', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ access_token: 't', expires_in: 60 }), { status: 200 });
      }),
    );
    await exchangeCode('c', 'v', 'r', 'custom-app');
    expect(new URL(capturedUrl).searchParams.get('client_id')).toBe('custom-app');
  });

  it('throws FacebookAdsOAuthTokenError on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":{"message":"Invalid code","code":100}}', { status: 400 }),
      ),
    );
    await expect(exchangeCode('c', 'v', 'r')).rejects.toMatchObject({
      name: 'FacebookAdsOAuthTokenError',
      status: 400,
      fbErrorMessage: 'Invalid code',
      fbErrorCode: 100,
    });
  });

  it('throws on a response with an error field but status 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: 'OAuthException', code: 190, type: 'OAuthException' },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(exchangeCode('c', 'v', 'r')).rejects.toMatchObject({
      name: 'FacebookAdsOAuthTokenError',
    });
  });
});

describe('fetchUserId', () => {
  it('returns the user id from graph.facebook.com/me', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: '123456789' }), { status: 200 })),
    );
    expect(await fetchUserId('tok')).toBe('123456789');
  });

  it('returns null on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('error', { status: 401 })),
    );
    expect(await fetchUserId('tok')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    expect(await fetchUserId('tok')).toBeNull();
  });

  it('returns null when id field is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ name: 'Alice' }), { status: 200 })),
    );
    expect(await fetchUserId('tok')).toBeNull();
  });
});
