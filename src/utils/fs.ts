import { writeFileSync, renameSync, unlinkSync } from 'node:fs';

/**
 * Write a file atomically with owner-only permissions.
 *
 * The data is written to a temp file created with mode 0600 and then renamed
 * over the target, so the file is never briefly world-readable and concurrent
 * readers (e.g. the keepalive cron) never see a half-written file.
 */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp file may not exist
    }
    throw error;
  }
}
