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
import { createLogger } from '../utils/logger';

const log = createLogger('db-writer-main');

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

  log.info({ url: config.url }, 'connecting to NATS');
  const nc = await connect(options);
  log.info('connected to NATS');
  return nc;
}

function createRedisClient(config: RedisConfig): Redis {
  const options: RedisOptions = {
    maxRetriesPerRequest: config.maxReconnectAttempts,
    retryStrategy: (times: number) => {
      if (times > config.maxReconnectAttempts) {
        log.error({ maxAttempts: config.maxReconnectAttempts }, 'max reconnect attempts exceeded');
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

  log.info({ url: config.url }, 'connecting to Redis');
  const client = new Redis(config.url, options);

  client.on('error', (err) => {
    log.error({ err }, 'redis error');
  });

  return client;
}

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    log.info('shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  log.info({ signal }, 'shutting down gracefully');

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

    log.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'error during shutdown');
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
    log.error({ err: error }, 'uncaught exception');
    void handleShutdown('UNCAUGHT_EXCEPTION');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled rejection');
    void handleShutdown('UNHANDLED_REJECTION');
  });
}

async function main(): Promise<void> {
  log.info('db writer service starting');

  try {
    const natsConfig = loadNatsConfig();
    const redisConfig = loadRedisConfig();
    const dbConfig = loadDbConfig();

    log.info({ natsUrl: natsConfig.url, redisUrl: redisConfig.url, dbUrl: dbConfig.url }, 'configuration');

    natsConnection = await createNatsConnection(natsConfig);
    redisClient = createRedisClient(redisConfig);
    await redisClient.connect();
    log.info('connected to Redis');

    const dbClient = new PostgresDbClient(dbConfig);
    dbWriterService = new DbWriterService(natsConnection, redisClient, dbClient, {
      maxConcurrency: 10,
    });
    await dbWriterService.start();

    log.info('db writer service is running');
  } catch (error) {
    log.error({ err: error }, 'failed to start service');
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

