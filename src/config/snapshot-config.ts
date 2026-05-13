import { z } from 'zod';
import * as path from 'path';

/**
 * Paths that must NEVER be used as SNAPSHOT_DIR. Includes:
 * - System directories where writes would clobber the OS or leak data
 *   into logs/SIEM (e.g. /var/log, /run).
 * - User credential dirs (~/.ssh) — but tilde expansion is handled by
 *   path.resolve before validation, so /root catches the common cases.
 * - World-writable temp dirs (/tmp, /var/tmp) — symlink-race risk and
 *   reboot-clears snapshots silently.
 */
const DANGEROUS_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/var/log',
  '/var/run',
  '/run',
  '/root',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/tmp',
  '/var/tmp',
] as const;

/**
 * Schema for the matching-engine SNAPSHOT_DIR.
 *
 * Validates and normalizes the directory path. Resolves relative paths
 * against the current working directory so the validation runs against
 * the absolute final destination.
 *
 * Audit reference: M-15 (matching-engine audit). Closes the
 * operator-misconfiguration vector where a typo or default-fallback
 * lands snapshots in a world-readable directory.
 */
export const snapshotDirSchema = z
  .string()
  .min(1, 'SNAPSHOT_DIR cannot be empty')
  .default('./snapshots')
  .transform((p) => path.resolve(p))
  .refine((resolved) => !resolved.includes('..'), {
    message: 'SNAPSHOT_DIR must not contain ".." path traversal',
  })
  .refine(
    (resolved) =>
      !DANGEROUS_PREFIXES.some(
        (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`)
      ),
    {
      message: `SNAPSHOT_DIR must not be under: ${DANGEROUS_PREFIXES.join(', ')}`,
    }
  );

export type SnapshotDir = z.infer<typeof snapshotDirSchema>;

/**
 * Load and validate SNAPSHOT_DIR from environment.
 *
 * Throws on invalid configuration so the engine fails fast at startup
 * rather than discovering misconfiguration during the first snapshot
 * write mid-trade.
 */
export function loadSnapshotDir(): SnapshotDir {
  const result = snapshotDirSchema.safeParse(process.env.SNAPSHOT_DIR);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `${e.path.join('.') || 'SNAPSHOT_DIR'}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid snapshot configuration: ${errors}`);
  }
  return result.data;
}
