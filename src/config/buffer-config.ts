/**
 * Buffer Configuration Module
 *
 * Provides configuration management for the match buffer retry,
 * monitoring thresholds, and disk persistence settings.
 * Loads values from environment variables with sensible defaults.
 */

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Schema for buffer configuration validation
 */
const bufferConfigSchema = z.object({
  /**
   * Initial delay before first retry attempt (in milliseconds)
   * @default 1000
   */
  retryInitialDelayMs: z.number().int().positive().default(1000),

  /**
   * Maximum delay between retry attempts (in milliseconds)
   * @default 30000
   */
  retryMaxDelayMs: z.number().int().positive().default(30000),

  /**
   * Multiplier applied to delay after each failed retry
   * @default 2
   */
  retryBackoffMultiplier: z.number().positive().default(2),

  /**
   * Buffer size thresholds that trigger warning logs (sorted ascending)
   * @default [1000, 5000, 10000]
   */
  warningThresholds: z.array(z.number().int().positive()).min(1).default([1000, 5000, 10000]),

  /**
   * Buffer size that triggers flushing unpublished matches to disk
   * @default 5000
   */
  diskSpillThreshold: z.number().int().positive().default(5000),

  /**
   * Directory for storing disk-spilled unpublished matches
   * @default './unpublished-matches'
   */
  diskSpillDir: z.string().min(1).default('./unpublished-matches'),

  /**
   * Maximum number of matches allowed in the in-memory buffer.
   * When exceeded, recordMatch() throws to apply backpressure.
   * 0 means no limit.
   * @default 10000
   */
  bufferMaxSize: z.number().int().nonnegative().default(10000),
});

/**
 * Buffer configuration type
 */
export type BufferConfig = z.infer<typeof bufferConfigSchema>;

/**
 * Load and validate buffer configuration from environment variables
 *
 * @returns Validated buffer configuration object
 * @throws {Error} If environment variables are invalid
 */
export function loadBufferConfig(): BufferConfig {
  const config = {
    retryInitialDelayMs: process.env.BUFFER_RETRY_INITIAL_DELAY_MS
      ? parseInt(process.env.BUFFER_RETRY_INITIAL_DELAY_MS, 10)
      : 1000,
    retryMaxDelayMs: process.env.BUFFER_RETRY_MAX_DELAY_MS
      ? parseInt(process.env.BUFFER_RETRY_MAX_DELAY_MS, 10)
      : 30000,
    retryBackoffMultiplier: process.env.BUFFER_RETRY_BACKOFF_MULTIPLIER
      ? parseFloat(process.env.BUFFER_RETRY_BACKOFF_MULTIPLIER)
      : 2,
    warningThresholds: process.env.BUFFER_WARNING_THRESHOLDS
      ? process.env.BUFFER_WARNING_THRESHOLDS.split(',').map((s) => parseInt(s.trim(), 10))
      : [1000, 5000, 10000],
    diskSpillThreshold: process.env.BUFFER_DISK_SPILL_THRESHOLD
      ? parseInt(process.env.BUFFER_DISK_SPILL_THRESHOLD, 10)
      : 5000,
    diskSpillDir: process.env.BUFFER_DISK_SPILL_DIR || './unpublished-matches',
    bufferMaxSize: process.env.BUFFER_MAX_SIZE ? parseInt(process.env.BUFFER_MAX_SIZE, 10) : 10000,
  };

  const result = bufferConfigSchema.safeParse(config);

  if (!result.success) {
    const errorMessages = result.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ');
    throw new Error(`Invalid buffer configuration: ${errorMessages}`);
  }

  return result.data;
}
