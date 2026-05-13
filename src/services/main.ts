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
import { PostgresDbClient } from './db/postgres-db-client';
import { loadSnapshotDir } from '../config/snapshot-config';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

/**
 * Service instance references for cleanup
 */
let natsService: NatsService | null = null;
let redisService: RedisService | null = null;
let matchingEngine: MatchingEngine | null = null;
let snapshotService: SnapshotService | null = null;
let snapshotTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;

/**
 * Handle graceful shutdown
 *
 * @param signal - Signal that triggered shutdown
 */
async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log('Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  console.log(`\n${signal} received. Shutting down gracefully...`);

  try {
    // Stop periodic snapshot timer
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }

    // Save final snapshot before shutdown
    if (matchingEngine && snapshotService) {
      console.log('Saving final snapshot before shutdown...');
      try {
        await matchingEngine.saveSnapshot();
        console.log('✓ Final snapshot saved');
      } catch (error) {
        console.warn('Failed to save final snapshot:', error);
      }
    }

    // Disconnect from NATS
    if (natsService) {
      await natsService.disconnect();
    }

    // Disconnect from Redis
    if (redisService) {
      await redisService.disconnect();
    }

    console.log('✓ Service shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

/**
 * Handle uncaught errors
 *
 * @param error - Uncaught error
 */
function handleUncaughtError(error: Error): void {
  console.error('Uncaught error:', error);
  
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
    console.log('=================================');
    console.log('Matching Engine Service Starting');
    console.log('=================================\n');

    // Display configuration
    console.log('Configuration:');
    console.log(`  NATS URL: ${process.env.NATS_URL || 'nats://localhost:4222'}`);
    console.log(`  Redis URL: ${process.env.REDIS_URL || 'redis://localhost:6379'}`);
    console.log(`  Node Environment: ${process.env.NODE_ENV || 'development'}\n`);

    // Initialize Redis service first (optional - continues without it if connection fails)
    // Redis is used as the settlement publisher for the matching engine
    console.log('Initializing Redis service...');
    try {
      redisService = new RedisService();
      await redisService.connect();
      console.log();
    } catch (redisError) {
      console.warn('⚠ Redis connection failed, settlement publishing disabled');
      console.warn(`  Error: ${redisError instanceof Error ? redisError.message : 'Unknown error'}`);
      console.log();
      redisService = null;
    }

    // Initialize snapshot service (if enabled)
    const snapshotEnabled = process.env.SNAPSHOT_ENABLED !== 'false';
    // M-15: validate SNAPSHOT_DIR at startup (fail-fast). Throws on
    // missing/dangerous/traversal paths before any service initializes.
    const snapshotDir = loadSnapshotDir();
    const snapshotRedisEnabled = process.env.SNAPSHOT_REDIS_ENABLED === 'true';

    if (snapshotEnabled) {
      console.log('Initializing snapshot service...');
      snapshotService = new SnapshotService(
        snapshotDir,
        redisService ?? null,
        snapshotRedisEnabled
      );
      console.log(`  Snapshot directory: ${snapshotDir}`);
      console.log(`  Redis backup: ${snapshotRedisEnabled ? 'Enabled' : 'Disabled'}`);
      console.log('✓ Snapshot service initialized\n');
    } else {
      console.log('Snapshot service: Disabled\n');
    }

    // Initialize matching engine with optional settlement publisher (Redis) and snapshot service
    console.log('Initializing matching engine...');
    matchingEngine = new MatchingEngine(redisService ?? undefined, snapshotService ?? undefined);
    console.log('✓ Matching engine initialized\n');

    // Restore state from snapshot if available (unless reset requested)
    if (snapshotService) {
      const snapshotResetOnStartup = process.env.SNAPSHOT_RESET_ON_STARTUP === 'true';
      if (snapshotResetOnStartup) {
        console.log('SNAPSHOT_RESET_ON_STARTUP=true: Starting with empty state (skipping restore)\n');
      } else {
        console.log('Attempting to restore state from snapshot...');
        const restored = await matchingEngine.restoreFromSnapshot();
        if (restored) {
          console.log('✓ State restored from snapshot\n');
        } else {
          console.log('  No snapshot found or restore failed, starting with empty state\n');
        }
      }
    }

    // Sync order book with database to ensure all active orders are in memory
    const dbSyncEnabled = process.env.DB_SYNC_ON_STARTUP !== 'false';
    if (dbSyncEnabled && process.env.DB_URL) {
      console.log('Syncing order book with database...');
      const dbClient = new PostgresDbClient();
      try {
        const [activeOrders, recentOrderIds] = await Promise.all([
          dbClient.getActiveOrders(),
          dbClient.getRecentOrderIds({ sinceDays: 7 }),
        ]);
        const syncResult = matchingEngine.syncFromDatabase(activeOrders, recentOrderIds);
        console.log(
          `✓ DB sync complete: ${syncResult.added} orders added, ${syncResult.skipped} already in memory, ${syncResult.dedupHydrated} ids in dedup set`
        );
      } catch (error) {
        console.warn(
          '⚠ DB sync failed, continuing with snapshot-only state:',
          error instanceof Error ? error.message : 'Unknown error'
        );
      } finally {
        await dbClient.close();
      }
      console.log();
    }

    // Initialize NATS service
    console.log('Initializing NATS service...');
    natsService = new NatsService(matchingEngine);
    await natsService.connect();
    console.log();

    // Display service statistics
    const natsStats = natsService.getStats();
    console.log('Service Status:');
    console.log(`  NATS Connected: ${natsStats.connected}`);
    console.log(`  Active Subscriptions: ${natsStats.subscriptions}`);
    console.log(`  NATS Server: ${natsStats.config.url}`);
    console.log(`  NATS Authentication: ${natsStats.config.hasAuth ? 'Enabled' : 'Disabled'}`);

    // Display Redis status
    if (redisService) {
      const redisStats = redisService.getStats();
      console.log(`  Redis Connected: ${redisStats.connected}`);
      console.log(`  Redis Server: ${redisStats.config.url}`);
      console.log(`  Redis Database: ${redisStats.config.db}`);

      // Get stream info
      const streamInfo = await redisService.getStreamInfo();
      if (streamInfo) {
        console.log(`  Settlement Stream Length: ${streamInfo.length}`);
        console.log(`  Consumer Groups: ${streamInfo.groups}`);
      }
    } else {
      console.log('  Redis: Disabled (settlement publishing disabled)');
    }

    // Start periodic snapshot timer if enabled
    if (snapshotService && matchingEngine) {
      const snapshotIntervalSeconds = parseInt(
        process.env.SNAPSHOT_INTERVAL_SECONDS || '30',
        10
      );
      if (snapshotIntervalSeconds > 0) {
        snapshotTimer = setInterval(() => {
          matchingEngine!.saveSnapshot().catch((error) => {
            console.warn('Periodic snapshot failed:', error);
          });
        }, snapshotIntervalSeconds * 1000);
        console.log(`  Periodic snapshots: Every ${snapshotIntervalSeconds} seconds`);
      }
    }

    console.log();
    console.log('=================================');
    console.log('Service is ready to process orders');
    console.log('Press Ctrl+C to stop');
    console.log('=================================\n');
  } catch (error) {
    console.error('Failed to start service:', error);
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
    console.error('Unhandled promise rejection:', reason);
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
    console.error('Fatal error during service startup:', error);
    process.exit(1);
  });
}

// Start the service if this file is run directly
if (require.main === module) {
  startService();
}

// Export for testing
export { main, handleShutdown, startService };

