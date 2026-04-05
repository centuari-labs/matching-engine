/**
 * Disk Persistence Service
 *
 * Handles flushing unpublished matches to disk and reloading them.
 * Uses atomic writes (write to .tmp, then rename) to prevent corruption.
 * File format is JSON Lines (one JSON object per line) for robustness.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Match } from '../types/matches';
import { matchSchema } from '../types/matches';
import { createLogger } from '../utils/logger';

const log = createLogger('disk-persistence');

export class DiskPersistenceService {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly tempFilePath: string;

  constructor(dir: string) {
    this.dir = dir;
    this.filePath = path.join(dir, 'unpublished-matches.jsonl');
    this.tempFilePath = path.join(dir, 'unpublished-matches.jsonl.tmp');
  }

  /**
   * Flush matches to disk using atomic write
   *
   * Writes to a temp file first, then renames to prevent partial writes.
   *
   * @param matches - Matches to persist
   */
  async flush(matches: Match[]): Promise<void> {
    if (matches.length === 0) return;

    // Ensure directory exists
    await fs.mkdir(this.dir, { recursive: true });

    // Write JSON Lines format
    const lines = matches.map((m) => JSON.stringify(m)).join('\n') + '\n';

    // Atomic write: temp file, then rename
    await fs.writeFile(this.tempFilePath, lines, 'utf-8');
    await fs.rename(this.tempFilePath, this.filePath);

    log.info({ count: matches.length, path: this.filePath }, 'flushed matches to disk');
  }

  /**
   * Load matches from disk, validate each line, and delete the file
   *
   * Malformed lines are skipped with a warning.
   *
   * @returns Array of valid matches
   */
  async load(): Promise<Match[]> {
    const content = await fs.readFile(this.filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const matches: Match[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        const match = matchSchema.parse(parsed);
        matches.push(match);
      } catch (error) {
        log.warn({ line: i + 1, err: error }, 'skipping malformed line in spill file');
      }
    }

    // Delete file after successful load
    await fs.unlink(this.filePath);
    log.info({ count: matches.length }, 'loaded matches from disk, file removed');

    return matches;
  }

  /**
   * Check if a spill file exists on disk
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }
}
