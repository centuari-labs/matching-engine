import type { OrderStatusMessage } from './messages';
import type { Match } from './matches';

/**
 * Event type used by the DB client for updating orders.
 *
 * Based on the enriched `OrderStatusMessage` published on the
 * `orders.status` topic.
 */
export type OrderStatusEvent = OrderStatusMessage;

/**
 * Event type used by the DB client for inserting matches.
 *
 * Matches are read from the Redis settlement stream and mapped back
 * into the core `Match` type.
 */
export type MatchEvent = Match;

/**
 * Minimal DB client abstraction used by DbWriterService.
 *
 * This allows the DB Writer to be tested independently of the actual
 * database driver/ORM.
 */
export interface DbClient {
  /**
   * Persist an order status transition.
   *
   * Implementations must be idempotent: applying the same event more than
   * once must leave the order row in the same final state.
   */
  updateOrderStatus(event: OrderStatusEvent): Promise<void>;

  /**
   * Insert a match row.
   *
   * Implementations should use a unique constraint on the match ID and
   * treat duplicates as a no-op to support at-least-once delivery from
   * the message brokers.
   */
  insertMatch(event: MatchEvent): Promise<void>;

  /**
   * Close any underlying resources (connection pools, etc).
   */
  close(): Promise<void>;
}

