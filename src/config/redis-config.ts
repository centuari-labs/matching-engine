/**
 * Redis Configuration Module
 *
 * Provides configuration management for Redis connection settings.
 * Loads values from environment variables with sensible defaults.
 */

import { z } from 'zod';

/**
 * Schema for Redis configuration validation
 */
const redisConfigSchema = z.object({
  /**
   * Redis server URL
   *
   * @example 'redis://localhost:6379'
   * @example 'redis://:password@localhost:6379'
   */
  url: z.string().min(1),

  /**
   * Optional password for authentication
   */
  password: z.string().optional(),

  /**
   * Redis database number
   * @default 0
   */
  db: z.number().int().min(0).max(15).default(0),

  /**
   * Maximum number of reconnection attempts
   * @default 10
   */
  maxReconnectAttempts: z.number().int().positive().default(10),

  /**
   * Time to wait between reconnection attempts (in milliseconds)
   * @default 2000
   */
  reconnectTimeWait: z.number().int().positive().default(2000),

  /**
   * Connection timeout (in milliseconds)
   * @default 10000
   */
  timeout: z.number().int().positive().default(10000),

  /**
   * Whether to enable TLS/SSL connection
   * @default false
   */
  tls: z.boolean().default(false),
});

/**
 * Redis configuration type
 */
export type RedisConfig = z.infer<typeof redisConfigSchema>;

/**
 * Load and validate Redis configuration from environment variables
 *
 * @returns Validated Redis configuration object
 * @throws {Error} If required environment variables are missing or invalid
 *
 * @example
 * ```typescript
 * const config = loadRedisConfig();
 * console.log(config.url); // 'redis://localhost:6379'
 * ```
 */
export function loadRedisConfig(): RedisConfig {
  const config = {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD,
    db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0,
    maxReconnectAttempts: process.env.REDIS_MAX_RECONNECT_ATTEMPTS
      ? parseInt(process.env.REDIS_MAX_RECONNECT_ATTEMPTS, 10)
      : 10,
    reconnectTimeWait: process.env.REDIS_RECONNECT_TIME_WAIT
      ? parseInt(process.env.REDIS_RECONNECT_TIME_WAIT, 10)
      : 2000,
    timeout: process.env.REDIS_TIMEOUT
      ? parseInt(process.env.REDIS_TIMEOUT, 10)
      : 10000,
    tls: process.env.REDIS_TLS === 'true',
  };

  // Validate configuration
  const result = redisConfigSchema.safeParse(config);

  if (!result.success) {
    const errorMessages = result.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ');
    throw new Error(`Invalid Redis configuration: ${errorMessages}`);
  }

  return result.data;
}

/**
 * Redis stream names for the matching engine service
 */
export const REDIS_STREAMS = {
  /**
   * Stream for settlement matches to be consumed by Settlement Engine
   */
  SETTLEMENT_MATCHES: 'settlement:matches',
} as const;

/**
 * Redis consumer group configuration
 */
export const REDIS_CONSUMER_GROUPS = {
  /**
   * Consumer group name for Settlement Engine
   */
  SETTLEMENT_ENGINE: 'settlement-engine',
} as const;

/**
 * Type for Redis stream keys
 */
export type RedisStreamKey = keyof typeof REDIS_STREAMS;

/**
 * Type for Redis stream values
 */
export type RedisStream = (typeof REDIS_STREAMS)[RedisStreamKey];
