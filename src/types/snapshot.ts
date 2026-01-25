import { z } from 'zod';
import { orderSchema } from './orders';
import { matchSchema } from './matches';

/**
 * Snapshot data schema containing serialized orders and matches
 */
export const snapshotDataSchema = z.object({
  /**
   * Snapshot version for compatibility checking
   */
  version: z.string().default('1.0.0'),
  /**
   * Timestamp when snapshot was created (milliseconds since epoch)
   */
  timestamp: z.number().int().positive(),
  /**
   * Array of all open orders in the order book
   */
  orders: z.array(orderSchema),
  /**
   * Array of unpublished matches in the execution engine
   */
  matches: z.array(matchSchema),
  /**
   * Metadata about the snapshot
   */
  metadata: z.object({
    /**
     * Total number of orders in the snapshot
     */
    orderCount: z.number().int().nonnegative(),
    /**
     * Total number of matches in the snapshot
     */
    matchCount: z.number().int().nonnegative(),
  }),
});

/**
 * Snapshot data type
 */
export type SnapshotData = z.infer<typeof snapshotDataSchema>;

/**
 * Snapshot metadata schema (stored separately for quick access)
 */
export const snapshotMetadataSchema = z.object({
  /**
   * Snapshot version
   */
  version: z.string(),
  /**
   * Timestamp when snapshot was created
   */
  timestamp: z.number().int().positive(),
  /**
   * Total number of orders
   */
  orderCount: z.number().int().nonnegative(),
  /**
   * Total number of matches
   */
  matchCount: z.number().int().nonnegative(),
  /**
   * File path to the snapshot (for filesystem storage)
   */
  filePath: z.string().optional(),
});

/**
 * Snapshot metadata type
 */
export type SnapshotMetadata = z.infer<typeof snapshotMetadataSchema>;
