/**
 * Matching Engine Service Entry Point
 *
 * Initializes and starts the NATS-based matching engine service.
 * Handles graceful shutdown on process termination signals.
 */

import { MatchingEngine } from '../core/matching-engine';
import { NatsService } from './nats-service';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

/**
 * Service instance references for cleanup
 */
let natsService: NatsService | null = null;
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
    // Disconnect from NATS
    if (natsService) {
      await natsService.disconnect();
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
    console.log(`  Node Environment: ${process.env.NODE_ENV || 'development'}\n`);

    // Initialize matching engine
    console.log('Initializing matching engine...');
    const matchingEngine = new MatchingEngine();
    console.log('✓ Matching engine initialized\n');

    // Initialize NATS service
    console.log('Initializing NATS service...');
    natsService = new NatsService(matchingEngine);
    await natsService.connect();
    console.log();

    // Display service statistics
    const stats = natsService.getStats();
    console.log('Service Status:');
    console.log(`  Connected: ${stats.connected}`);
    console.log(`  Active Subscriptions: ${stats.subscriptions}`);
    console.log(`  NATS Server: ${stats.config.url}`);
    console.log(`  Authentication: ${stats.config.hasAuth ? 'Enabled' : 'Disabled'}\n`);

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

