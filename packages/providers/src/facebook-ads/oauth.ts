import { createHash, randomBytes } from 'node:crypto';

/**
 * Meta App ID used by the Facebook Ads MCP server (mcp.facebook.com/ads).
 * This is a public OAuth client — no client secret is needed for the PKCE
 * desktop flow. Users authenticate with their own Facebook Business account.
 *
 * Not affiliated with Meta Platforms, Inc. Source: mcp.facebook.com/ads.
 */
export const CLIENT_ID = 'facebook_ads_mcp';
export const AUTH_BASE = 'https://www.facebook.com';
export const TOKEN_URL = 'https://graph.facebook.com/oauth/access_token';
export const ADS_SCOPES = 'ads_read,ads_management,business_management';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthorizeUrlOpts {
  redirectUri: string;
  state: string;
  challenge: string;
  clientId?: string;
}

export function buildAuthorizeUrl(opts: AuthorizeUrlOpts): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId ?? CLIENT_ID,
    redirect_uri: opts.redirectUri,
    scope: ADS_SCOPES,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    state: opts.state,
  });
  return `${AUTH_BASE}/dialog/oauth?${params.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  userId: string | null;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: { message?: string; code?: number; type?: string };
}

export class FacebookAdsOAuthTokenError extends Error {
  public readonly kind: 'exchange';
  public readonly status: number;
  public readonly responseBody: string;
  public readonly fbErrorMessage: string | undefined;
  public readonly fbErrorCode: number | undefined;

  constructor(input: {
    kind: 'exchange';
    status: number;
    responseBody: string;
    fbErrorMessage: string | undefined;
    fbErrorCode: number | undefined;
  }) {
    super(
      `Facebook Ads OAuth ${input.kind} failed: ${input.status}${formatErrorDetail(input.fbErrorMessage, input.fbErrorCode)}`,
    );
    this.name = 'FacebookAdsOAuthTokenError';
    this.kind = input.kind;
    this.status = input.status;
    this.responseBody = input.responseBody;
    this.fbErrorMessage = input.fbErrorMessage;
    this.fbErrorCode = input.fbErrorCode;
  }
}

function formatErrorDetail(message: string | undefined, code: number | undefined): string {
  if (message !== undefined && code !== undefined) return ` (${code}) ${message}`;
  if (message !== undefined) return ` ${message}`;
  if (code !== undefined) return ` code ${code}`;
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTokenResponse(text: string): TokenResponse {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return {};
    return parsed as TokenResponse;
  } catch {
    return {};
  }
}

export async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  clientId?: string,
): Promise<TokenSet> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId ?? CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch(`${TOKEN_URL}?${params.toString()}`, { method: 'GET' });
  const text = await res.text();
  const json = parseTokenResponse(text);

  if (!res.ok || json.error !== undefined) {
    const err = isRecord(json.error) ? json.error : {};
    throw new FacebookAdsOAuthTokenError({
      kind: 'exchange',
      status: res.status,
      responseBody: text,
      fbErrorMessage: typeof err['message'] === 'string' ? err['message'] : undefined,
      fbErrorCode: typeof err['code'] === 'number' ? err['code'] : undefined,
    });
  }

  return {
    accessToken: json.access_token ?? '',
    expiresAt: Date.now() + (json.expires_in ?? 0) * 1000,
    userId: null,
  };
}

/**
 * Fetch the Facebook user ID associated with the given access token.
 * Returns null on any failure — callers should treat null as "unknown".
 */
export async function fetchUserId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/me?fields=id&access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (!isRecord(json)) return null;
    const id = json['id'];
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
