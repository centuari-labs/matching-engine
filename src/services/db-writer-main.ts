/**
 * DB Writer Service Entry Point
 *
 * Initializes and starts the standalone DB Writer service that:
 *  - Subscribes to NATS `orders.status` events
 *  - Consumes Redis Stream `settlement:matches` (own consumer group)
 *  - Persists order updates and matches into the database
 *
 * This service runs independently from the main matching engine process
 * and does not introduce any DB calls into the matching engine hot path.
 */

import * as dotenv from 'dotenv';
import { connect, type ConnectionOptions, type NatsConnection } from 'nats';
import Redis, { type RedisOptions } from 'ioredis';
import { loadNatsConfig, type NatsConfig } from '../config/nats-config';
import { loadRedisConfig, type RedisConfig } from '../config/redis-config';
import { loadDbConfig } from '../config/db-config';
import { DbWriterService } from './db-writer-service';
import { PostgresDbClient } from './db/postgres-db-client';

// Load environment variables from .env file
dotenv.config();

let natsConnection: NatsConnection | null = null;
let redisClient: Redis | null = null;
let dbWriterService: DbWriterService | null = null;
let isShuttingDown = false;

async function createNatsConnection(config: NatsConfig): Promise<NatsConnection> {
  const options: ConnectionOptions = {
    servers: config.url.split(','),
    maxReconnectAttempts: config.maxReconnectAttempts,
    reconnectTimeWait: config.reconnectTimeWait,
    timeout: config.timeout,
  };

  if (config.user && config.password) {
    options.user = config.user;
    options.pass = config.password;
  } else if (config.token) {
    options.token = config.token;
  }

  console.log(`DB Writer: connecting to NATS at ${config.url}...`);
  const nc = await connect(options);
  console.log('DB Writer: connected to NATS');
  return nc;
}

function createRedisClient(config: RedisConfig): Redis {
  const options: RedisOptions = {
    maxRetriesPerRequest: config.maxReconnectAttempts,
    retryStrategy: (times: number) => {
      if (times > config.maxReconnectAttempts) {
        console.error(
          `DB Writer Redis: max reconnect attempts (${config.maxReconnectAttempts}) exceeded`
        );
        return null;
      }
      return config.reconnectTimeWait;
    },
    connectTimeout: config.timeout,
    db: config.db,
    lazyConnect: true,
  };

  if (config.password) {
    options.password = config.password;
  }

  if (config.tls) {
    options.tls = {};
  }

  console.log(`DB Writer: connecting to Redis at ${config.url}...`);
  const client = new Redis(config.url, options);

  client.on('error', (err) => {
    console.error('DB Writer Redis error:', err);
  });

  return client;
}

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log('DB Writer: shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  console.log(`\nDB Writer: ${signal} received, shutting down gracefully...`);

  try {
    if (dbWriterService) {
      await dbWriterService.stop();
    }

    if (natsConnection) {
      await natsConnection.drain();
      natsConnection = null;
    }

    if (redisClient) {
      await redisClient.quit();
      redisClient = null;
    }

    console.log('DB Writer: shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('DB Writer: error during shutdown', error);
    process.exit(1);
  }
}

function setupSignalHandlers(): void {
  process.on('SIGINT', () => {
    void handleShutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void handleShutdown('SIGTERM');
  });
  process.on('uncaughtException', (error) => {
    console.error('DB Writer: uncaught exception', error);
    void handleShutdown('UNCAUGHT_EXCEPTION');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('DB Writer: unhandled rejection', reason);
    void handleShutdown('UNHANDLED_REJECTION');
  });
}

async function main(): Promise<void> {
  console.log('=================================');
  console.log('DB Writer Service Starting');
  console.log('=================================\n');

  try {
    const natsConfig = loadNatsConfig();
    const redisConfig = loadRedisConfig();
    const dbConfig = loadDbConfig();

    console.log('DB Writer Configuration:');
    console.log(`  NATS URL: ${natsConfig.url}`);
    console.log(`  Redis URL: ${redisConfig.url}`);
    console.log(`  DB URL: ${dbConfig.url}`);
    console.log('');

    natsConnection = await createNatsConnection(natsConfig);
    redisClient = createRedisClient(redisConfig);
    await redisClient.connect();
    console.log('DB Writer: connected to Redis');

    const dbClient = new PostgresDbClient(dbConfig);
    dbWriterService = new DbWriterService(natsConnection, redisClient, dbClient, {
      maxConcurrency: 10,
    });
    await dbWriterService.start();

    console.log('\n=================================');
    console.log('DB Writer Service is running');
    console.log('Press Ctrl+C to stop');
    console.log('=================================\n');
  } catch (error) {
    console.error('DB Writer: failed to start service', error);
    process.exit(1);
  }
}

function startDbWriterService(): void {
  setupSignalHandlers();
  void main();
}

if (require.main === module) {
  startDbWriterService();
}

export { startDbWriterService, main, handleShutdown };

