import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';

export interface StoredFacebookAdsAuth {
  schemaVersion: 1;
  accessToken: string;
  expiresAt: number;
  userId: string | null;
  updatedAt: number;
}

export interface FacebookAdsTokenStoreOptions {
  filePath: string;
  now?: () => number;
}

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const NOT_LOGGED_IN_MSG = 'Facebook Ads is not signed in. Please log in via Settings.';

function isStoredFacebookAdsAuth(value: unknown): value is StoredFacebookAdsAuth {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['schemaVersion'] === 1 &&
    typeof v['accessToken'] === 'string' &&
    typeof v['expiresAt'] === 'number' &&
    (v['userId'] === null || typeof v['userId'] === 'string') &&
    typeof v['updatedAt'] === 'number'
  );
}

export class FacebookAdsTokenStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private cache: StoredFacebookAdsAuth | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: FacebookAdsTokenStoreOptions) {
    this.filePath = opts.filePath;
    this.now = opts.now ?? Date.now;
  }

  async read(): Promise<StoredFacebookAdsAuth | null> {
    let body: string;
    try {
      body = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = null;
        return null;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (cause) {
      throw new CodesignError(
        `Invalid Facebook Ads token store at ${this.filePath}`,
        ERROR_CODES.FACEBOOK_ADS_TOKEN_PARSE_FAILED,
        { cause },
      );
    }
    if (!isStoredFacebookAdsAuth(parsed)) {
      throw new CodesignError(
        `Invalid Facebook Ads token store at ${this.filePath}`,
        ERROR_CODES.FACEBOOK_ADS_TOKEN_PARSE_FAILED,
      );
    }
    this.cache = parsed;
    return parsed;
  }

  async write(auth: StoredFacebookAdsAuth): Promise<void> {
    const op = this.writeChain.then(() => this.writeNow(auth));
    this.writeChain = op.catch(() => {});
    await op;
  }

  private async writeNow(auth: StoredFacebookAdsAuth): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const body = JSON.stringify(auth, null, 2);
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
      await rename(tmpPath, this.filePath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        // ignore — tmp may not exist if writeFile itself failed
      }
      throw err;
    }
    this.cache = auth;
  }

  async clear(): Promise<void> {
    this.cache = null;
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /**
   * Returns the stored access token if present and not expired. Facebook
   * tokens don't support automated refresh — when expired the user must
   * re-authenticate.
   */
  async getValidAccessToken(): Promise<string> {
    if (this.cache === null) {
      await this.read();
    }
    if (this.cache === null) {
      throw new CodesignError(NOT_LOGGED_IN_MSG, ERROR_CODES.FACEBOOK_ADS_TOKEN_NOT_LOGGED_IN);
    }
    if (this.now() >= this.cache.expiresAt - EXPIRY_BUFFER_MS) {
      await this.clear();
      throw new CodesignError(
        'Facebook Ads token has expired. Please re-login via Settings.',
        ERROR_CODES.FACEBOOK_ADS_TOKEN_NOT_LOGGED_IN,
      );
    }
    return this.cache.accessToken;
  }

  /** True when a non-expired token is in cache or on disk. */
  async isLoggedIn(): Promise<boolean> {
    try {
      await this.getValidAccessToken();
      return true;
    } catch {
      return false;
    }
  }
}
