/**
 * Matching Engine Service Entry Point
 *
 * Initializes and starts the NATS-based matching engine service.
 * Handles graceful shutdown on process termination signals.
 */

import { MatchingEngine } from '../core/matching-engine';
import { NatsService } from './nats-service';
import { RedisService } from './redis-service';
import { SnapshotService } from './snapshot-service';
import { RetryService } from './retry-service';
import { DiskPersistenceService } from './disk-persistence-service';
import { PostgresDbClient } from './db/postgres-db-client';
import { loadBufferConfig } from '../config/buffer-config';
import { createLogger } from '../utils/logger';
import * as dotenv from 'dotenv';

const log = createLogger('main');

// Load environment variables from .env file
dotenv.config();

/**
 * Service instance references for cleanup
 */
let natsService: NatsService | null = null;
let redisService: RedisService | null = null;
let matchingEngine: MatchingEngine | null = null;
let snapshotService: SnapshotService | null = null;
let retryService: RetryService | null = null;
let diskPersistenceService: DiskPersistenceService | null = null;
let snapshotTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;

/**
 * Handle graceful shutdown
 *
 * @param signal - Signal that triggered shutdown
 */
async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    log.info('shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  log.info({ signal }, 'shutting down gracefully');

  try {
    // Stop periodic snapshot timer
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }

    // Save final snapshot before shutdown
    if (matchingEngine && snapshotService) {
      log.info('saving final snapshot before shutdown');
      try {
        await matchingEngine.saveSnapshot();
        log.info('final snapshot saved');
      } catch (error) {
        log.warn({ err: error }, 'failed to save final snapshot');
      }
    }

    // Flush unpublished matches to disk and shutdown retry service
    if (matchingEngine && diskPersistenceService) {
      try {
        const unpublished = matchingEngine.getExecutionEngine().getUnpublishedMatches();
        if (unpublished.length > 0) {
          await diskPersistenceService.flush(unpublished);
          log.info({ count: unpublished.length }, 'flushed unpublished matches to disk');
        }
      } catch (error) {
        log.warn({ err: error }, 'failed to flush unpublished matches to disk');
      }
    }

    if (retryService) {
      retryService.shutdown();
    }

    // Disconnect from NATS
    if (natsService) {
      await natsService.disconnect();
    }

    // Disconnect from Redis
    if (redisService) {
      await redisService.disconnect();
    }

    log.info('service shutdown complete');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

/**
 * Handle uncaught errors
 *
 * @param error - Uncaught error
 */
function handleUncaughtError(error: Error): void {
  log.error({ err: error }, 'uncaught error');

  // Attempt graceful shutdown
  handleShutdown('UNCAUGHT_ERROR').catch(() => {
    process.exit(1);
  });
}

/**
 * Main service initialization function
 */
async function main(): Promise<void> {
  try {
    log.info('matching engine service starting');

    // Display configuration
    log.info(
      {
        natsUrl: process.env.NATS_URL || 'nats://localhost:4222',
        redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
        nodeEnv: process.env.NODE_ENV || 'development',
      },
      'configuration'
    );

    // Initialize Redis service first (optional - continues without it if connection fails)
    // Redis is used as the settlement publisher for the matching engine
    log.info('initializing Redis service');
    try {
      redisService = new RedisService();
      await redisService.connect();
    } catch (redisError) {
      log.warn({ err: redisError }, 'Redis connection failed, settlement publishing disabled');
      redisService = null;
    }

    // Initialize snapshot service (if enabled)
    const snapshotEnabled = process.env.SNAPSHOT_ENABLED !== 'false';
    const snapshotDir = process.env.SNAPSHOT_DIR || './snapshots';
    const snapshotRedisEnabled = process.env.SNAPSHOT_REDIS_ENABLED === 'true';

    if (snapshotEnabled) {
      log.info('initializing snapshot service');
      snapshotService = new SnapshotService(
        snapshotDir,
        redisService ?? null,
        snapshotRedisEnabled
      );
      log.info({ snapshotDir, redisBackup: snapshotRedisEnabled }, 'snapshot service initialized');
    } else {
      log.info('snapshot service disabled');
    }

    // Initialize buffer management (retry + disk persistence)
    log.info('initializing buffer management');
    const bufferConfig = loadBufferConfig();
    diskPersistenceService = new DiskPersistenceService(bufferConfig.diskSpillDir);
    retryService = new RetryService(diskPersistenceService, bufferConfig);
    log.info(
      {
        retryInitialDelayMs: bufferConfig.retryInitialDelayMs,
        retryMaxDelayMs: bufferConfig.retryMaxDelayMs,
        warningThresholds: bufferConfig.warningThresholds,
        diskSpillThreshold: bufferConfig.diskSpillThreshold,
        diskSpillDir: bufferConfig.diskSpillDir,
        bufferMaxSize: bufferConfig.bufferMaxSize,
      },
      'buffer management initialized'
    );

    // Initialize matching engine with optional settlement publisher (Redis) and snapshot service
    log.info('initializing matching engine');
    matchingEngine = new MatchingEngine(
      redisService ?? undefined,
      snapshotService ?? undefined,
      retryService,
      bufferConfig.warningThresholds,
      bufferConfig.diskSpillThreshold,
      bufferConfig.bufferMaxSize
    );
    retryService.setExecutionEngine(matchingEngine.getExecutionEngine());
    log.info('matching engine initialized');

    // Restore state from snapshot if available (unless reset requested)
    if (snapshotService) {
      const snapshotResetOnStartup = process.env.SNAPSHOT_RESET_ON_STARTUP === 'true';
      if (snapshotResetOnStartup) {
        log.info('SNAPSHOT_RESET_ON_STARTUP=true, starting with empty state');
      } else {
        log.info('attempting to restore state from snapshot');
        const restored = await matchingEngine.restoreFromSnapshot();
        if (restored) {
          log.info('state restored from snapshot');
        } else {
          log.info('no snapshot found or restore failed, starting with empty state');
        }
      }
    }

    // Restore disk-spilled matches if any exist from a previous crash
    if (diskPersistenceService && matchingEngine) {
      try {
        const hasSpill = await diskPersistenceService.exists();
        if (hasSpill) {
          log.info('loading disk-spilled unpublished matches');
          const spilledMatches = await diskPersistenceService.load();
          if (spilledMatches.length > 0) {
            matchingEngine.getExecutionEngine().mergeMatches(spilledMatches);
            log.info({ count: spilledMatches.length }, 'merged matches from disk spill');
            // Retry publishing all recovered matches
            for (const match of spilledMatches) {
              matchingEngine.getExecutionEngine().retryPublish(match.matchId);
            }
            log.info('queued recovered matches for publishing');
          }
        }
      } catch (error) {
        log.warn({ err: error }, 'failed to load disk-spilled matches');
      }
    }

    // Sync order book with database to ensure all active orders are in memory
    const dbSyncEnabled = process.env.DB_SYNC_ON_STARTUP !== 'false';
    if (dbSyncEnabled && process.env.DB_URL) {
      log.info('syncing order book with database');
      const dbClient = new PostgresDbClient();
      try {
        const activeOrders = await dbClient.getActiveOrders();
        const syncResult = matchingEngine.syncFromDatabase(activeOrders);
        log.info({ added: syncResult.added, skipped: syncResult.skipped }, 'DB sync complete');
      } catch (error) {
        log.warn({ err: error }, 'DB sync failed, continuing with snapshot-only state');
      } finally {
        await dbClient.close();
      }
    }

    // Initialize NATS service
    log.info('initializing NATS service');
    natsService = new NatsService(matchingEngine);
    await natsService.connect();

    // Display service statistics
    const natsStats = natsService.getStats();
    log.info(
      {
        natsConnected: natsStats.connected,
        subscriptions: natsStats.subscriptions,
        natsServer: natsStats.config.url,
        natsAuth: natsStats.config.hasAuth,
      },
      'NATS status'
    );

    // Display Redis status
    if (redisService) {
      const redisStats = redisService.getStats();
      const streamInfo = await redisService.getStreamInfo();
      log.info(
        {
          redisConnected: redisStats.connected,
          redisServer: redisStats.config.url,
          redisDb: redisStats.config.db,
          streamLength: streamInfo?.length ?? 0,
          consumerGroups: streamInfo?.groups ?? 0,
        },
        'Redis status'
      );
    } else {
      log.info('Redis disabled (settlement publishing disabled)');
    }

    // Start periodic snapshot timer if enabled
    if (snapshotService && matchingEngine) {
      const snapshotIntervalSeconds = parseInt(process.env.SNAPSHOT_INTERVAL_SECONDS || '30', 10);
      if (snapshotIntervalSeconds > 0) {
        snapshotTimer = setInterval(() => {
          matchingEngine!.saveSnapshot().catch((error) => {
            log.warn({ err: error }, 'periodic snapshot failed');
          });
        }, snapshotIntervalSeconds * 1000);
        log.info({ intervalSeconds: snapshotIntervalSeconds }, 'periodic snapshots enabled');
      }
    }

    log.info('service is ready to process orders');
  } catch (error) {
    log.error({ err: error }, 'failed to start service');
    process.exit(1);
  }
}

/**
 * Set up process signal handlers
 */
function setupSignalHandlers(): void {
  // Handle graceful shutdown signals
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', handleUncaughtError);
  process.on('unhandledRejection', (reason: unknown) => {
    log.error({ err: reason }, 'unhandled promise rejection');
    handleUncaughtError(new Error(String(reason)));
  });
}

/**
 * Start the service
 */
function startService(): void {
  // Set up signal handlers first
  setupSignalHandlers();

  // Start main service
  main().catch((error) => {
    log.error({ err: error }, 'fatal error during service startup');
    process.exit(1);
  });
}

// Start the service if this file is run directly
if (require.main === module) {
  startService();
}

// Export for testing
export { main, handleShutdown, startService };
