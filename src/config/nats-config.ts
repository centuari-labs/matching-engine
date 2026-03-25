/**
 * NATS Configuration Module
 *
 * Provides configuration management for NATS connection settings.
 * Loads values from environment variables with sensible defaults.
 */

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Schema for NATS configuration validation
 */
const natsConfigSchema = z.object({
  /**
   * NATS server URL(s)
   *
   * Can be a single URL or comma-separated list of URLs for clustering.
   * @example 'nats://localhost:4222'
   * @example 'nats://server1:4222,nats://server2:4222'
   */
  url: z.string().min(1),

  /**
   * Optional username for authentication
   */
  user: z.string().optional(),

  /**
   * Optional password for authentication
   */
  password: z.string().optional(),

  /**
   * Optional token for authentication
   */
  token: z.string().optional(),

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
});

/**
 * NATS configuration type
 */
export type NatsConfig = z.infer<typeof natsConfigSchema>;

/**
 * Load and validate NATS configuration from environment variables
 *
 * @returns Validated NATS configuration object
 * @throws {Error} If required environment variables are missing or invalid
 *
 * @example
 * ```typescript
 * const config = loadNatsConfig();
 * console.log(config.url); // 'nats://localhost:4222'
 * ```
 */
export function loadNatsConfig(): NatsConfig {
  const config = {
    url: process.env.NATS_URL || 'nats://localhost:4222',
    user: process.env.NATS_USER,
    password: process.env.NATS_PASSWORD,
    token: process.env.NATS_TOKEN,
    maxReconnectAttempts: process.env.NATS_MAX_RECONNECT_ATTEMPTS
      ? parseInt(process.env.NATS_MAX_RECONNECT_ATTEMPTS, 10)
      : 10,
    reconnectTimeWait: process.env.NATS_RECONNECT_TIME_WAIT
      ? parseInt(process.env.NATS_RECONNECT_TIME_WAIT, 10)
      : 2000,
    timeout: process.env.NATS_TIMEOUT
      ? parseInt(process.env.NATS_TIMEOUT, 10)
      : 10000,
  };

  // Validate configuration
  const result = natsConfigSchema.safeParse(config);

  if (!result.success) {
    const errorMessages = result.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ');
    throw new Error(`Invalid NATS configuration: ${errorMessages}`);
  }

  return result.data;
}

/**
 * NATS topic names for the matching engine service
 */
export const NATS_TOPICS = {
  // Input topics (subscribe)
  ORDERS_LEND_MARKET: 'orders.lend.market',
  ORDERS_LEND_LIMIT: 'orders.lend.limit',
  ORDERS_BORROW_MARKET: 'orders.borrow.market',
  ORDERS_BORROW_LIMIT: 'orders.borrow.limit',
  ORDERS_CANCEL: 'orders.cancel',

  // Output topics (publish)
  ORDERS_STATUS: 'orders.status',
  ORDERS_CANCELLED_REMAINDER: 'orders.cancelled_remainder',
  MATCHES_CREATED: 'matches.created',
  ORDERS_UPDATED: 'orders.updated',
  ERRORS: 'errors',
} as const;

/**
 * Type for NATS topic keys
 */
export type NatsTopicKey = keyof typeof NATS_TOPICS;

/**
 * Type for NATS topic values
 */
export type NatsTopic = (typeof NATS_TOPICS)[NatsTopicKey];

