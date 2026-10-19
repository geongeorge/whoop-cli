import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/client.js', () => ({
  fetchData: vi.fn().mockResolvedValue({ date: 'x', fetched_at: 'y' }),
}));

import { fetchData } from '../api/client.js';
import { toLocalStart, toLocalEnd, getWhoopDay } from '../utils/date.js';

class ExitError extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}

let logs: string[];

beforeEach(() => {
  vi.mocked(fetchData).mockClear();
  logs = [];
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new ExitError(code); }) as never);
  vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });
  vi.spyOn(console, 'error').mockImplementation((msg: string) => { logs.push(msg); });
});

async function run(...args: string[]): Promise<number> {
  // Fresh program each run: commander keeps option values between parses
  vi.resetModules();
  const { program } = await import('../cli.js');
  try {
    await program.parseAsync(['node', 'whoop', ...args, '--format', 'json']);
    return 0;
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  }
}

describe('data command validation', () => {
  it('rejects impossible dates', async () => {
    expect(await run('sleep', '--date', '2026-02-31')).toBe(1);
    expect(logs.join()).toContain('Invalid date \\"2026-02-31\\"');
    expect(fetchData).not.toHaveBeenCalled();
  });

  it.each(['0', '26', '10.5', 'abc'])('rejects --limit %s', async (limit) => {
    expect(await run('sleep', '--limit', limit)).toBe(1);
    expect(logs.join()).toContain('Limit must be a whole number between 1 and 25');
    expect(fetchData).not.toHaveBeenCalled();
  });

  it('treats --start alone as start through today', async () => {
    expect(await run('recovery', '--start', '2026-01-01')).toBe(0);
    expect(fetchData).toHaveBeenCalledWith(['recovery'], expect.any(String), expect.objectContaining({
      start: toLocalStart('2026-01-01'),
      end: toLocalEnd(getWhoopDay()),
    }));
  });

  it('rejects --end without --start', async () => {
    expect(await run('recovery', '--end', '2026-01-10')).toBe(1);
    expect(logs.join()).toContain('--end requires --start');
  });

  it('rejects start after end', async () => {
    expect(await run('multi', '--sleep', '--start', '2026-02-01', '--end', '2026-01-01')).toBe(1);
    expect(logs.join()).toContain('is after end date');
  });

  it('passes a valid range and limit through', async () => {
    expect(await run('workout', '--start', '2026-01-01', '--end', '2026-01-07', '--limit', '10')).toBe(0);
    expect(fetchData).toHaveBeenCalledWith(['workout'], expect.any(String), expect.objectContaining({
      limit: 10,
      start: toLocalStart('2026-01-01'),
      end: toLocalEnd('2026-01-07'),
    }));
  });
});
