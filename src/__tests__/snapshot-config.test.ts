import * as path from 'path';
import * as os from 'os';
import { snapshotDirSchema, loadSnapshotDir } from '../config/snapshot-config';

/**
 * M-15 audit fix tests.
 *
 * The schema must:
 * - Resolve relative paths to absolute (so the validator sees the
 *   final destination, not the relative shorthand).
 * - Reject paths under dangerous prefixes — both top-level system
 *   dirs and world-writable temp roots.
 * - Reject path traversal (".." components).
 * - Accept reasonable defaults and user-controlled directories.
 *
 * Also tests `loadSnapshotDir()` env-var integration.
 */
describe('M-15: snapshotDirSchema', () => {
  describe('accepts', () => {
    it('the default "./snapshots" relative to cwd', () => {
      const result = snapshotDirSchema.parse(undefined);
      expect(result).toBe(path.resolve('./snapshots'));
    });

    it('an absolute path under user-controlled directories', () => {
      const dir = path.join(os.homedir(), 'centuari-snapshots-test');
      const result = snapshotDirSchema.parse(dir);
      expect(result).toBe(dir);
    });

    it('a relative path that resolves outside dangerous prefixes', () => {
      const result = snapshotDirSchema.parse('./snapshots-data');
      expect(result).toBe(path.resolve('./snapshots-data'));
    });
  });

  describe('rejects', () => {
    it('paths under system dirs like /etc, /proc, /sys, /dev', () => {
      for (const bad of ['/etc/centuari', '/proc/snapshots', '/sys/something', '/dev/snapshots']) {
        expect(() => snapshotDirSchema.parse(bad)).toThrow(/must not be under/);
      }
    });

    it('paths under world-writable temp dirs', () => {
      expect(() => snapshotDirSchema.parse('/tmp/snapshots')).toThrow(/must not be under/);
      expect(() => snapshotDirSchema.parse('/var/tmp/snapshots')).toThrow(/must not be under/);
    });

    it('paths under log/run/credential dirs', () => {
      for (const bad of ['/var/log/snapshots', '/run/snapshots', '/root/snapshots']) {
        expect(() => snapshotDirSchema.parse(bad)).toThrow(/must not be under/);
      }
    });

    it('an empty string', () => {
      expect(() => snapshotDirSchema.parse('')).toThrow(/cannot be empty/);
    });

    // Note: path.resolve() in transform() normalizes ".." away before
    // refinement sees it, so we can't directly trigger the ".."
    // traversal refinement from end-user input. The refinement still
    // exists as belt-and-suspenders against future code that bypasses
    // the transform.
  });
});

describe('M-15: loadSnapshotDir() env integration', () => {
  const originalEnv = process.env.SNAPSHOT_DIR;

  afterEach(() => {
    process.env.SNAPSHOT_DIR = originalEnv;
  });

  it('uses the default when SNAPSHOT_DIR is unset', () => {
    delete process.env.SNAPSHOT_DIR;
    expect(loadSnapshotDir()).toBe(path.resolve('./snapshots'));
  });

  it('throws a structured error when SNAPSHOT_DIR is invalid', () => {
    process.env.SNAPSHOT_DIR = '/tmp/bad';
    expect(() => loadSnapshotDir()).toThrow(/Invalid snapshot configuration/);
  });

  it('accepts a user-controlled path via env', () => {
    process.env.SNAPSHOT_DIR = '/opt/centuari/snapshots';
    expect(loadSnapshotDir()).toBe('/opt/centuari/snapshots');
  });
});
