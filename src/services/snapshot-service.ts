import * as fs from 'fs/promises';
import * as path from 'path';
import type { OrderBook } from '../core/order-book';
import type { ExecutionEngine } from '../core/execution-engine';
import type { SnapshotData, SnapshotMetadata } from '../types/snapshot';
import { snapshotDataSchema, snapshotMetadataSchema } from '../types/snapshot';
import type { RedisService } from './redis-service';
import { createLogger } from '../utils/logger';

const log = createLogger('snapshot-service');

/**
 * Snapshot service for persisting and restoring matching engine state
 *
 * Uses filesystem as primary storage and optionally Redis as secondary backup.
 * Filesystem is always the source of truth for recovery.
 */
export class SnapshotService {
  private snapshotDir: string;
  private redisService: RedisService | null;
  private redisEnabled: boolean;

  /**
   * Create a new SnapshotService instance
   *
   * @param snapshotDir - Directory path for snapshot files (default: './snapshots')
   * @param redisService - Optional Redis service for secondary backup
   * @param redisEnabled - Whether to use Redis as secondary backup (default: false)
   */
  constructor(
    snapshotDir: string = './snapshots',
    redisService: RedisService | null = null,
    redisEnabled: boolean = false
  ) {
    this.snapshotDir = snapshotDir;
    this.redisService = redisService;
    this.redisEnabled = redisEnabled;
  }

  /**
   * Ensure the snapshot directory exists
   *
   * @throws {Error} If directory creation fails
   */
  private async ensureDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.snapshotDir, { recursive: true });
    } catch (error) {
      throw new Error(
        `Failed to create snapshot directory ${this.snapshotDir}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Get file paths for snapshot files
   *
   * @returns Object with file paths
   */
  private getFilePaths(): {
    latest: string;
    backup: string;
    temp: string;
    metadata: string;
  } {
    return {
      latest: path.join(this.snapshotDir, 'latest.json'),
      backup: path.join(this.snapshotDir, 'backup.json'),
      temp: path.join(this.snapshotDir, 'latest.json.tmp'),
      metadata: path.join(this.snapshotDir, 'metadata.json'),
    };
  }

  /**
   * Save snapshot to filesystem and optionally to Redis
   *
   * @param orderBook - OrderBook instance to extract orders from
   * @param executionEngine - ExecutionEngine instance to extract matches from
   * @returns Promise that resolves when snapshot is saved
   */
  async saveSnapshot(orderBook: OrderBook, executionEngine: ExecutionEngine): Promise<void> {
    try {
      // Ensure directory exists
      await this.ensureDirectory();

      // Extract state from order book and execution engine
      const orders = orderBook.getAllOrders();
      const matches = executionEngine.getUnpublishedMatches();

      // Create snapshot data
      const snapshotData: SnapshotData = {
        version: '1.0.0',
        timestamp: Date.now(),
        orders,
        matches,
        metadata: {
          orderCount: orders.length,
          matchCount: matches.length,
        },
      };

      // Validate snapshot data
      snapshotDataSchema.parse(snapshotData);

      // Serialize to JSON
      const jsonData = JSON.stringify(snapshotData, null, 2);

      // Get file paths
      const filePaths = this.getFilePaths();

      // Atomic write: write to temp file first, then rename
      await fs.writeFile(filePaths.temp, jsonData, 'utf-8');

      // Rotate backup: move current latest to backup
      try {
        const latestExists = await fs
          .access(filePaths.latest)
          .then(() => true)
          .catch(() => false);
        if (latestExists) {
          await fs.rename(filePaths.latest, filePaths.backup);
        }
      } catch (error) {
        // Log but don't fail if backup rotation fails
        log.warn({ err: error }, 'failed to rotate backup snapshot');
      }

      // Atomic rename: temp -> latest
      await fs.rename(filePaths.temp, filePaths.latest);

      // Save metadata
      const metadata: SnapshotMetadata = {
        version: snapshotData.version,
        timestamp: snapshotData.timestamp,
        orderCount: snapshotData.metadata.orderCount,
        matchCount: snapshotData.metadata.matchCount,
        filePath: filePaths.latest,
      };
      await fs.writeFile(filePaths.metadata, JSON.stringify(metadata, null, 2), 'utf-8');

      // Optionally save to Redis (non-blocking, silent failures)
      if (this.redisEnabled && this.redisService?.isServiceConnected()) {
        this.saveToRedis(snapshotData, metadata).catch((error) => {
          // Silent failure - Redis is only secondary backup
          log.warn({ err: error }, 'failed to save snapshot to Redis (non-critical)');
        });
      }

      log.info({ orderCount: snapshotData.metadata.orderCount, matchCount: snapshotData.metadata.matchCount }, 'snapshot saved');
    } catch (error) {
      // Log error but don't throw - snapshot failures shouldn't block operations
      log.error({ err: error }, 'failed to save snapshot');
      throw error; // Re-throw for caller to handle if needed
    }
  }

  /**
   * Save snapshot to Redis (secondary backup)
   *
   * @param snapshotData - Snapshot data to save
   * @param metadata - Snapshot metadata
   */
  private async saveToRedis(
    snapshotData: SnapshotData,
    metadata: SnapshotMetadata
  ): Promise<void> {
    if (!this.redisService || !this.redisService.isServiceConnected()) {
      return;
    }

    const client = this.redisService.getClient();
    if (!client) {
      return;
    }

    try {
      // Rotate backup
      const backupData = await client.get('matching-engine:snapshot:backup');
      if (backupData) {
        await client.set('matching-engine:snapshot:backup', backupData);
      }

      // Save latest snapshot
      await client.set('matching-engine:snapshot:latest', JSON.stringify(snapshotData));

      // Save metadata
      await client.set('matching-engine:snapshot:metadata', JSON.stringify(metadata));
    } catch (error) {
      // Silent failure - Redis is optional
      throw error;
    }
  }

  /**
   * Load snapshot from filesystem (primary) or Redis (fallback)
   *
   * @returns Snapshot data if found, null otherwise
   */
  async loadSnapshot(): Promise<SnapshotData | null> {
    // Try filesystem first (primary source)
    try {
      const filePaths = this.getFilePaths();
      const data = await fs.readFile(filePaths.latest, 'utf-8');
      const snapshotData = JSON.parse(data) as SnapshotData;

      // Validate with Zod
      const validated = snapshotDataSchema.parse(snapshotData);
      log.info({ orderCount: validated.metadata.orderCount, matchCount: validated.metadata.matchCount, source: 'filesystem' }, 'snapshot loaded');
      return validated;
    } catch (error) {
      // Filesystem failed, try Redis fallback if enabled
      if (this.redisEnabled && this.redisService?.isServiceConnected()) {
        try {
          const snapshotData = await this.loadFromRedis();
          if (snapshotData) {
            log.info({ orderCount: snapshotData.metadata.orderCount, matchCount: snapshotData.metadata.matchCount, source: 'redis' }, 'snapshot loaded');
            return snapshotData;
          }
        } catch (redisError) {
          log.warn({ err: redisError }, 'failed to load snapshot from Redis fallback');
        }
      }

      // No snapshot found or all sources failed
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info('no snapshot found, first startup');
      } else {
        log.warn({ err: error }, 'failed to load snapshot');
      }
      return null;
    }
  }

  /**
   * Load snapshot from Redis (fallback only)
   *
   * @returns Snapshot data if found, null otherwise
   */
  private async loadFromRedis(): Promise<SnapshotData | null> {
    if (!this.redisService || !this.redisService.isServiceConnected()) {
      return null;
    }

    const client = this.redisService.getClient();
    if (!client) {
      return null;
    }

    try {
      const data = await client.get('matching-engine:snapshot:latest');
      if (!data) {
        return null;
      }

      const snapshotData = JSON.parse(data) as SnapshotData;
      return snapshotDataSchema.parse(snapshotData);
    } catch (error) {
      throw new Error(
        `Failed to load snapshot from Redis: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get snapshot metadata
   *
   * @returns Snapshot metadata if found, null otherwise
   */
  async getSnapshotMetadata(): Promise<SnapshotMetadata | null> {
    try {
      const filePaths = this.getFilePaths();
      const data = await fs.readFile(filePaths.metadata, 'utf-8');
      const metadata = JSON.parse(data) as SnapshotMetadata;
      return snapshotMetadataSchema.parse(metadata);
    } catch (error) {
      // Try Redis if filesystem fails
      if (this.redisEnabled && this.redisService?.isServiceConnected()) {
        try {
          const client = this.redisService.getClient();
          if (client) {
            const data = await client.get('matching-engine:snapshot:metadata');
            if (data) {
              const metadata = JSON.parse(data) as SnapshotMetadata;
              return snapshotMetadataSchema.parse(metadata);
            }
          }
        } catch (redisError) {
          // Silent failure
        }
      }

      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null; // No metadata file (first startup)
      }
      log.warn({ err: error }, 'failed to load snapshot metadata');
      return null;
    }
  }
}
