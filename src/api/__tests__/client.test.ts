import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhoopError, ExitCode } from '../../utils/errors.js';

vi.mock('../../auth/tokens.js', () => ({
  getValidTokens: vi.fn().mockResolvedValue({ access_token: 'test-token' }),
  refreshAccessToken: vi.fn().mockResolvedValue({ access_token: 'refreshed-token' }),
}));

import { refreshAccessToken } from '../../auth/tokens.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(body == null ? '' : JSON.stringify(body)),
  } as Response;
}

describe('API client request()', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(refreshAccessToken).mockClear();
  });

  it('makes authenticated requests with correct headers', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1, first_name: 'Test' }));

    const { getProfile } = await import('../client.js');
    const result = await getProfile();

    expect(result).toEqual({ id: 1, first_name: 'Test' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/user/profile/basic'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  it('throws WhoopError with AUTH_ERROR on 401', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 401));

    const { getProfile } = await import('../client.js');

    await expect(getProfile()).rejects.toThrow(WhoopError);
    await expect(getProfile()).rejects.toMatchObject({
      message: 'Authentication failed. Run: whoop auth login',
      code: ExitCode.AUTH_ERROR,
      statusCode: 401,
    });
  });

  it('refreshes the token and retries once on 401', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }));

    const { getProfile } = await import('../client.js');
    const result = await getProfile();

    expect(result).toEqual({ id: 1 });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer refreshed-token');
  });

  it('includes the API error message in the thrown error', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ message: 'limit must be <= 25' }, 400));

    const { getSleep } = await import('../client.js');

    await expect(getSleep({ limit: 50 })).rejects.toMatchObject({
      message: 'API request failed: limit must be <= 25',
      code: ExitCode.GENERAL_ERROR,
      statusCode: 400,
    });
  });

  it('reports Retry-After on 429', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 429, { 'retry-after': '30' }));

    const { getBody } = await import('../client.js');

    await expect(getBody()).rejects.toMatchObject({
      message: 'Rate limit exceeded (retry after 30s)',
      code: ExitCode.RATE_LIMIT,
    });
  });

  it('throws WhoopError with RATE_LIMIT on 429', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 429));

    const { getBody } = await import('../client.js');

    await expect(getBody()).rejects.toThrow(WhoopError);
    await expect(getBody()).rejects.toMatchObject({
      message: 'Rate limit exceeded',
      code: ExitCode.RATE_LIMIT,
      statusCode: 429,
    });
  });

  it('throws WhoopError with GENERAL_ERROR on other HTTP errors', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 500));

    const { getProfile } = await import('../client.js');

    await expect(getProfile()).rejects.toThrow(WhoopError);
    await expect(getProfile()).rejects.toMatchObject({
      message: 'API request failed',
      code: ExitCode.GENERAL_ERROR,
      statusCode: 500,
    });
  });

  it('throws WhoopError with GENERAL_ERROR on 403', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 403));

    const { getProfile } = await import('../client.js');

    await expect(getProfile()).rejects.toThrow(WhoopError);
    await expect(getProfile()).rejects.toMatchObject({
      code: ExitCode.GENERAL_ERROR,
      statusCode: 403,
    });
  });
});

describe('API client fetchAll() pagination', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetches single page of results', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ records: [{ id: 1 }, { id: 2 }], next_token: undefined })
    );

    const { getSleep } = await import('../client.js');
    const result = await getSleep({ start: '2024-01-01', end: '2024-01-02' });

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches all pages when all=true', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ records: [{ id: 1 }], next_token: 'page2' })
      )
      .mockResolvedValueOnce(
        jsonResponse({ records: [{ id: 2 }], next_token: undefined })
      );

    const { getSleep } = await import('../client.js');
    const result = await getSleep({ start: '2024-01-01', end: '2024-01-02' }, true);

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain('nextToken=page2');
  });

  it('stops after first page when all=false even with next_token', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ records: [{ id: 1 }], next_token: 'page2' })
    );

    const { getRecovery } = await import('../client.js');
    const result = await getRecovery({ start: '2024-01-01', end: '2024-01-02' }, false);

    expect(result).toEqual([{ id: 1 }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('propagates HTTP errors during pagination', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ records: [{ id: 1 }], next_token: 'page2' })
      )
      .mockResolvedValueOnce(jsonResponse(null, 429));

    const { getSleep } = await import('../client.js');

    await expect(
      getSleep({ start: '2024-01-01', end: '2024-01-02' }, true)
    ).rejects.toMatchObject({
      code: ExitCode.RATE_LIMIT,
      statusCode: 429,
    });
  });
});

describe('API client network failures', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('propagates fetch failures as-is (not caught in client)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const { getProfile } = await import('../client.js');

    await expect(getProfile()).rejects.toThrow('fetch failed');
  });

  it('propagates ECONNREFUSED errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    const { getProfile } = await import('../client.js');

    await expect(getProfile()).rejects.toThrow('ECONNREFUSED');
  });
});
