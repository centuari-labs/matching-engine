import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Schema for database configuration validation
 */
const dbConfigSchema = z.object({
  /**
   * Database connection URL
   *
   * Example for Postgres:
   *   postgres://user:password@localhost:5432/matching_engine
   */
  url: z.string().min(1, 'DB_URL is required'),

  /**
   * Maximum number of connections in the pool
   */
  maxPoolSize: z.number().int().positive().default(10),

  /**
   * Idle timeout for pooled connections (in milliseconds)
   */
  idleTimeoutMillis: z.number().int().nonnegative().default(30_000),
});

export type DbConfig = z.infer<typeof dbConfigSchema>;

/**
 * Load and validate DB configuration from environment variables
 */
export function loadDbConfig(): DbConfig {
  const config = {
    url: process.env.DB_URL ?? '',
    maxPoolSize: process.env.DB_MAX_POOL_SIZE
      ? parseInt(process.env.DB_MAX_POOL_SIZE, 10)
      : 10,
    idleTimeoutMillis: process.env.DB_IDLE_TIMEOUT_MS
      ? parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10)
      : 30_000,
  };

  const result = dbConfigSchema.safeParse(config);

  if (!result.success) {
    const errorMessages = result.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ');
    throw new Error(`Invalid DB configuration: ${errorMessages}`);
  }

  return result.data;
}

