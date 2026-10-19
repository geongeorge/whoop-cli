import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, openSync, statSync, unlinkSync, renameSync } from 'node:fs';
import type { TokenData } from '../../types/whoop.js';

vi.mock('node:fs');
vi.mock('node:os', () => ({ homedir: vi.fn(() => '/fake/home') }));

let loadTokens: typeof import('../tokens.js').loadTokens;
let isTokenExpired: typeof import('../tokens.js').isTokenExpired;
let refreshAccessToken: typeof import('../tokens.js').refreshAccessToken;
let getValidTokens: typeof import('../tokens.js').getValidTokens;
let getTokenStatus: typeof import('../tokens.js').getTokenStatus;

const validTokens: TokenData = {
  access_token: 'access-123',
  refresh_token: 'refresh-456',
  expires_at: Math.floor(Date.now() / 1000) + 7200,
  token_type: 'bearer',
  scope: 'read:profile offline',
};

const expiredTokens: TokenData = {
  ...validTokens,
  expires_at: Math.floor(Date.now() / 1000) - 100,
};

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(mkdirSync).mockReturnValue(undefined);
  vi.mocked(writeFileSync).mockReturnValue(undefined);
  vi.mocked(chmodSync).mockReturnValue(undefined);

  delete process.env.WHOOP_CLIENT_ID;
  delete process.env.WHOOP_CLIENT_SECRET;

  const mod = await import('../tokens.js');
  loadTokens = mod.loadTokens;
  isTokenExpired = mod.isTokenExpired;
  refreshAccessToken = mod.refreshAccessToken;
  getValidTokens = mod.getValidTokens;
  getTokenStatus = mod.getTokenStatus;
});

describe('loadTokens', () => {
  it('returns null when token file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadTokens()).toBeNull();
  });

  it('returns null on corrupt token file', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('not-json{{{');
    expect(loadTokens()).toBeNull();
  });

  it('returns parsed tokens when file is valid', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validTokens));
    expect(loadTokens()).toEqual(validTokens);
  });
});

describe('isTokenExpired', () => {
  it('returns true for expired tokens', () => {
    expect(isTokenExpired(expiredTokens)).toBe(true);
  });

  it('returns true when within refresh buffer (15 min)', () => {
    const nearExpiry: TokenData = {
      ...validTokens,
      expires_at: Math.floor(Date.now() / 1000) + 800, // 13 min left, within 15 min buffer
    };
    expect(isTokenExpired(nearExpiry)).toBe(true);
  });

  it('returns false for tokens with plenty of time left', () => {
    expect(isTokenExpired(validTokens)).toBe(false);
  });
});

describe('refreshAccessToken', () => {
  it('throws when no credentials are configured', async () => {
    // No env vars, no config file
    await expect(refreshAccessToken(validTokens)).rejects.toThrow('No credentials found');
  });

  it('throws on HTTP error from token endpoint', async () => {
    process.env.WHOOP_CLIENT_ID = 'test-id';
    process.env.WHOOP_CLIENT_SECRET = 'test-secret';

    // Re-import so config module picks up env vars
    vi.resetModules();
    const mod = await import('../tokens.js');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token is expired' })),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(mod.refreshAccessToken(validTokens)).rejects.toThrow('Refresh token is expired');

    vi.unstubAllGlobals();
  });

  it('throws generic message when error response is not JSON', async () => {
    process.env.WHOOP_CLIENT_ID = 'test-id';
    process.env.WHOOP_CLIENT_SECRET = 'test-secret';

    vi.resetModules();
    const mod = await import('../tokens.js');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(mod.refreshAccessToken(validTokens)).rejects.toThrow('Token refresh failed (500)');

    vi.unstubAllGlobals();
  });

  it('throws on network failure during refresh', async () => {
    process.env.WHOOP_CLIENT_ID = 'test-id';
    process.env.WHOOP_CLIENT_SECRET = 'test-secret';

    vi.resetModules();
    const mod = await import('../tokens.js');

    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(mod.refreshAccessToken(validTokens)).rejects.toThrow('fetch failed');

    vi.unstubAllGlobals();
  });

  it('preserves existing refresh_token when response omits it', async () => {
    process.env.WHOOP_CLIENT_ID = 'test-id';
    process.env.WHOOP_CLIENT_SECRET = 'test-secret';

    vi.resetModules();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(writeFileSync).mockReturnValue(undefined);
    vi.mocked(chmodSync).mockReturnValue(undefined);

    const mod = await import('../tokens.js');

    // Response without refresh_token (e.g. WHOOP occasionally omitting it)
    const responseWithoutRefreshToken = {
      access_token: 'new-access',
      expires_in: 7200,
      token_type: 'bearer',
      scope: 'read:profile offline',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responseWithoutRefreshToken),
    });
    vi.stubGlobal('fetch', mockFetch);

    // loadTokens after save returns tokens with preserved refresh_token
    vi.mocked(existsSync).mockReturnValue(true);
    const savedTokens: TokenData = {
      access_token: 'new-access',
      refresh_token: 'refresh-456', // preserved from original validTokens
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      token_type: 'bearer',
      scope: 'read:profile offline',
    };
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(savedTokens));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await mod.refreshAccessToken(validTokens);

    // The saved data must include the existing refresh_token (not undefined)
    const written = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.refresh_token).toBe('refresh-456');
    expect(result.access_token).toBe('new-access');
    // Warning should be logged
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('WARNING'));

    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('saves refreshed tokens on success', async () => {
    process.env.WHOOP_CLIENT_ID = 'test-id';
    process.env.WHOOP_CLIENT_SECRET = 'test-secret';

    vi.resetModules();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(writeFileSync).mockReturnValue(undefined);
    vi.mocked(chmodSync).mockReturnValue(undefined);

    const mod = await import('../tokens.js');

    const newTokenResponse = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 7200,
      token_type: 'bearer',
      scope: 'read:profile offline',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(newTokenResponse),
    });
    vi.stubGlobal('fetch', mockFetch);

    // After saveTokens, loadTokens will read the file — mock that read
    vi.mocked(existsSync).mockReturnValue(true);
    const savedTokens: TokenData = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      token_type: 'bearer',
      scope: 'read:profile offline',
    };
    // Disk holds the pre-refresh tokens until saveTokens writes the new ones
    vi.mocked(readFileSync)
      .mockReturnValueOnce(JSON.stringify(validTokens))
      .mockReturnValue(JSON.stringify(savedTokens));

    const result = await mod.refreshAccessToken(validTokens);
    expect(result.access_token).toBe('new-access');
    expect(writeFileSync).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('getValidTokens', () => {
  it('throws when not authenticated (no token file)', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    await expect(getValidTokens()).rejects.toThrow('Not authenticated');
  });

  it('returns tokens directly when not expired', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validTokens));

    // Re-import to pick up fresh mocks
    vi.resetModules();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validTokens));
    const mod = await import('../tokens.js');

    const result = await mod.getValidTokens();
    expect(result.access_token).toBe('access-123');
  });

  it('triggers refresh when tokens are expired', async () => {
    process.env.WHOOP_CLIENT_ID = 'test-id';
    process.env.WHOOP_CLIENT_SECRET = 'test-secret';

    vi.resetModules();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(writeFileSync).mockReturnValue(undefined);
    vi.mocked(chmodSync).mockReturnValue(undefined);

    // First read returns expired tokens, second read returns refreshed tokens
    let readCount = 0;
    vi.mocked(readFileSync).mockImplementation(() => {
      readCount++;
      if (readCount <= 1) return JSON.stringify(expiredTokens);
      return JSON.stringify({ ...validTokens, access_token: 'refreshed-access' });
    });

    const mod = await import('../tokens.js');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'refreshed-access',
        refresh_token: 'new-refresh',
        expires_in: 7200,
        token_type: 'bearer',
        scope: 'read:profile offline',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await mod.getValidTokens();
    expect(result.access_token).toBe('refreshed-access');
    expect(mockFetch).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('getTokenStatus', () => {
  it('returns unauthenticated when no tokens', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(getTokenStatus()).toEqual({ authenticated: false });
  });

  it('returns authenticated with expires_at when tokens exist', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validTokens));
    const status = getTokenStatus();
    expect(status.authenticated).toBe(true);
    expect(status.expires_at).toBe(validTokens.expires_at);
  });
});

describe('refresh concurrency', () => {
  const refreshed = {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 3600,
    token_type: 'bearer',
    scope: 'offline',
  };

  async function setup() {
    process.env.WHOOP_CLIENT_ID = 'test-id';
    process.env.WHOOP_CLIENT_SECRET = 'test-secret';
    vi.resetModules();

    // Simulated disk: tokens.json reflects whatever was last written
    let disk = JSON.stringify(expiredTokens);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => disk);
    vi.mocked(writeFileSync).mockImplementation((_p, data) => { disk = data as string; });
    vi.mocked(renameSync).mockReturnValue(undefined);
    vi.mocked(openSync).mockReturnValue(3);

    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, json: () => Promise.resolve(refreshed) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await import('../tokens.js');
    return { mod, fetchMock, setDisk: (t: TokenData) => { disk = JSON.stringify(t); } };
  }

  it('parallel callers share a single refresh request', async () => {
    const { mod, fetchMock } = await setup();

    const results = await Promise.all([
      mod.getValidTokens(),
      mod.getValidTokens(),
      mod.getValidTokens(),
      mod.getValidTokens(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((t) => t.refresh_token === 'new-refresh')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('skips refreshing when another process already rotated the token', async () => {
    const { mod, fetchMock, setDisk } = await setup();
    setDisk({ ...validTokens, refresh_token: 'rotated-elsewhere' });

    const result = await mod.refreshAccessToken(expiredTokens);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.refresh_token).toBe('rotated-elsewhere');
    vi.unstubAllGlobals();
  });

  it('breaks a stale lock left by a crashed process', async () => {
    const { mod, fetchMock } = await setup();
    const eexist = Object.assign(new Error('exists'), { code: 'EEXIST' });
    vi.mocked(openSync).mockImplementationOnce(() => { throw eexist; });
    vi.mocked(statSync).mockReturnValue({ mtimeMs: Date.now() - 60_000 } as any);

    await mod.refreshAccessToken(expiredTokens);

    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining('refresh.lock'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
