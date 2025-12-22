/**
 * Settlement Message Types
 *
 * Defines the message format for settlement data published to Redis Streams.
 * The Settlement Engine consumes these messages to process on-chain settlements.
 */

import type { Match } from './matches';

/**
 * Settlement match type - same as Match since Match now includes wallet addresses
 *
 * Contains all necessary information for the Settlement Engine to execute
 * the on-chain settlement of a matched order.
 */
export type SettlementMatch = Match;

/**
 * Interface for publishing settlement matches
 *
 * Implementations handle the actual publishing to a message broker (e.g., Redis Streams).
 * This abstraction allows the core matching logic to remain decoupled from infrastructure.
 */
export interface SettlementPublisher {
  /**
   * Publish a settlement match to the message broker
   *
   * @param match - Settlement match to publish
   * @returns Message ID if successful, null if publish failed
   */
  publishSettlementMatch(match: SettlementMatch): Promise<string | null>;
}

/**
 * Create a settlement match from a Match object
 *
 * @param match - Match object with all required fields
 * @returns Settlement match message (same as input, type assertion)
 */
export function createSettlementMatch(match: Match): SettlementMatch {
  return match;
}
