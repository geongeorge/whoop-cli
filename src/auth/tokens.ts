import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TokenData, OAuthTokenResponse } from '../types/whoop.js';
import { getCredentials } from './config.js';
import { WhoopError, ExitCode } from '../utils/errors.js';
import { writeFileAtomic } from '../utils/fs.js';

const CONFIG_DIR = join(homedir(), '.whoop-cli');
const TOKEN_FILE = join(CONFIG_DIR, 'tokens.json');
const LOCK_FILE = join(CONFIG_DIR, 'refresh.lock');

// How long to wait for another process's refresh, and when to treat its lock as abandoned
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 100;

// Refresh tokens 15 minutes before expiry to avoid race conditions
const REFRESH_BUFFER_SECONDS = 900;

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function saveTokens(response: OAuthTokenResponse): void {
  ensureConfigDir();

  const data: TokenData = {
    access_token: response.access_token,
    refresh_token: response.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + response.expires_in,
    token_type: response.token_type,
    scope: response.scope,
  };

  writeFileAtomic(TOKEN_FILE, JSON.stringify(data, null, 2));
}

export function loadTokens(): TokenData | null {
  if (!existsSync(TOKEN_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(TOKEN_FILE, 'utf-8');
    return JSON.parse(content) as TokenData;
  } catch {
    return null;
  }
}

export function clearTokens(): void {
  if (existsSync(TOKEN_FILE)) {
    writeFileSync(TOKEN_FILE, '');
  }
}

export function isTokenExpired(tokens: TokenData): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now >= tokens.expires_at - REFRESH_BUFFER_SECONDS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cross-process lock so the keepalive cron and a user command never spend the
 * same single-use refresh token. Returns a release function.
 */
async function acquireRefreshLock(): Promise<() => void> {
  ensureConfigDir();
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      closeSync(openSync(LOCK_FILE, 'wx', 0o600));
      return () => {
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          // already removed
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    try {
      if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(LOCK_FILE);
        continue;
      }
    } catch {
      // lock released between our open and stat — retry immediately
      continue;
    }

    if (Date.now() > deadline) {
      throw new WhoopError('Timed out waiting for another token refresh to finish', ExitCode.AUTH_ERROR);
    }
    await sleep(LOCK_POLL_MS);
  }
}

// In-process dedupe: parallel requests (e.g. `summary` fetching 4 endpoints)
// share one refresh instead of each spending the same refresh token.
let refreshInFlight: Promise<TokenData> | null = null;

/**
 * Exchange the refresh token for a new token pair.
 *
 * WHOOP refresh tokens are single-use, and reusing a spent one can revoke the
 * whole token chain. Concurrent callers in this process share one refresh, and
 * a file lock serializes refreshes across processes. If another caller already
 * rotated the token, the newer tokens on disk are returned without refreshing.
 */
export function refreshAccessToken(tokens: TokenData): Promise<TokenData> {
  if (!refreshInFlight) {
    refreshInFlight = refreshWithLock(tokens).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function refreshWithLock(tokens: TokenData): Promise<TokenData> {
  const release = await acquireRefreshLock();
  try {
    const current = loadTokens();
    if (current && current.refresh_token && current.refresh_token !== tokens.refresh_token) {
      return current;
    }
    return await doRefresh(current ?? tokens);
  } finally {
    release();
  }
}

async function doRefresh(tokens: TokenData): Promise<TokenData> {
  const creds = getCredentials();

  if (!creds) {
    throw new WhoopError('No credentials found. Run: whoop auth login', ExitCode.AUTH_ERROR);
  }

  const { clientId, clientSecret } = creds;

  const response = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'offline',
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errorMsg = `Token refresh failed (${response.status})`;
    try {
      const errorJson = JSON.parse(errorBody);
      errorMsg = errorJson.error_description || errorJson.error || errorMsg;
    } catch {
      // Use default error message
    }
    throw new WhoopError(errorMsg, ExitCode.AUTH_ERROR, response.status);
  }

  const data = (await response.json()) as OAuthTokenResponse;

  // WHOOP uses single-use refresh token rotation and should always return a new
  // refresh_token. If it's absent from the response, preserve the existing one to
  // prevent tokens.json from losing the field (which would cause a 400 on the
  // next refresh attempt).
  if (!data.refresh_token) {
    console.error('[whoop-cli] WARNING: WHOOP did not return a refresh_token in the refresh response — preserving existing token');
    data.refresh_token = tokens.refresh_token;
  }

  saveTokens(data);

  // Log confirmation so keepalive.log shows exactly what was persisted
  const saved = loadTokens()!;
  console.error(`[whoop-cli] tokens saved — expires_at: ${saved.expires_at}, refresh_token: ${saved.refresh_token ? 'present' : 'MISSING'}`);

  return saved;
}

export async function getValidTokens(): Promise<TokenData> {
  let tokens = loadTokens();

  if (!tokens) {
    throw new WhoopError('Not authenticated. Run: whoop-cli auth login', ExitCode.AUTH_ERROR);
  }

  if (isTokenExpired(tokens)) {
    tokens = await refreshAccessToken(tokens);
  }

  return tokens;
}

export function getTokenStatus(): { authenticated: boolean; expires_at?: number } {
  const tokens = loadTokens();
  if (!tokens) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    expires_at: tokens.expires_at,
  };
}
