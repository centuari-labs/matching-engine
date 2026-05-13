import { z } from 'zod';
import { orderSchema } from './orders';
import { matchSchema } from './matches';

/**
 * Snapshot data schema containing serialized orders, matches, and dedup state.
 *
 * Version history:
 * - 1.0.0 — initial: orders + matches
 * - 1.1.0 — adds `submittedOrderIds` for M-1 Layer A dedup persistence
 */
export const snapshotDataSchema = z.object({
  /**
   * Snapshot version for compatibility checking. The enum guards against
   * silent acceptance of future formats; bump and add a value when the
   * schema gains/loses required fields.
   */
  version: z.enum(['1.0.0', '1.1.0']).default('1.1.0'),
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
   * Order IDs submitted to the engine within the dedup window.
   *
   * Added in v1.1.0. Loading a v1.0.0 snapshot will leave this empty;
   * the matching engine will hydrate it via DB sync on startup.
   */
  submittedOrderIds: z.array(z.string()).default([]),
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
