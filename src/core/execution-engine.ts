import type { Match } from '../types/matches';
import { matchSchema } from '../types/matches';
import type { SettlementPublisher } from '../types/settlement';
import { generateMatchId } from '../utils/helpers';

/**
 * ExecutionEngine handles recording and managing match results
 *
 * Matches are temporarily stored in memory, then published to a settlement publisher.
 * On successful publish, matches are removed from memory to optimize memory usage.
 * Failed publishes keep the match in memory as a fallback buffer.
 */
export class ExecutionEngine {
  /** Store all matches by matchId (temporary buffer until published) */
  private matches: Map<string, Match>;

  /** Index matches by order ID for quick lookups */
  private matchesByLendOrder: Map<string, string[]>;
  private matchesByBorrowOrder: Map<string, string[]>;

  /** Optional publisher for settlement matches */
  private settlementPublisher?: SettlementPublisher;

  /**
   * Create a new ExecutionEngine instance
   *
   * @param settlementPublisher - Optional publisher for settlement matches
   */
  constructor(settlementPublisher?: SettlementPublisher) {
    this.matches = new Map();
    this.matchesByLendOrder = new Map();
    this.matchesByBorrowOrder = new Map();
    this.settlementPublisher = settlementPublisher;
  }

  /**
   * Record a new match
   *
   * Stores the match in memory temporarily, then publishes to settlement publisher.
   * On successful publish, match is removed from memory to optimize memory usage.
   * On failed publish, match remains in memory as a fallback buffer.
   *
   * @param params - Match parameters
   * @returns The created match
   */
  recordMatch(params: {
    lendOrderId: string;
    borrowOrderId: string;
    lenderAccountId: string;
    borrowerAccountId: string;
    matchedAmount: string;
    rate: number;
    assetId: string;
    marketId: string;
    borrowerIsTaker: boolean;
    makerFeeAmount: string;
    takerFeeAmount: string;
    lenderSettlementFeeAmount: string;
    borrowerSettlementFeeAmount: string;
  }): Match {
    const match: Match = {
      matchId: generateMatchId(),
      lendOrderId: params.lendOrderId,
      borrowOrderId: params.borrowOrderId,
      lenderAccountId: params.lenderAccountId,
      borrowerAccountId: params.borrowerAccountId,
      matchedAmount: params.matchedAmount,
      rate: params.rate,
      assetId: params.assetId,
      marketId: params.marketId,
      timestamp: Date.now(),
      borrowerIsTaker: params.borrowerIsTaker,
      makerFeeAmount: params.makerFeeAmount,
      takerFeeAmount: params.takerFeeAmount,
      lenderSettlementFeeAmount: params.lenderSettlementFeeAmount,
      borrowerSettlementFeeAmount: params.borrowerSettlementFeeAmount,
    };

    // Validate match against schema
    matchSchema.parse(match);

    // Store match in memory (temporary buffer)
    this.matches.set(match.matchId, match);

    // Index by lend order
    if (!this.matchesByLendOrder.has(params.lendOrderId)) {
      this.matchesByLendOrder.set(params.lendOrderId, []);
    }
    this.matchesByLendOrder.get(params.lendOrderId)!.push(match.matchId);

    // Index by borrow order
    if (!this.matchesByBorrowOrder.has(params.borrowOrderId)) {
      this.matchesByBorrowOrder.set(params.borrowOrderId, []);
    }
    this.matchesByBorrowOrder.get(params.borrowOrderId)!.push(match.matchId);

    // Publish to settlement publisher (async, non-blocking)
    if (this.settlementPublisher) {
      this.publishAndCleanup(match);
    }

    return match;
  }

  /**
   * Publish match to settlement publisher and remove from memory on success
   *
   * This is fire-and-forget (non-blocking). On success, the match is removed
   * from memory since Redis becomes the source of truth. On failure, the match
   * remains in memory as a fallback buffer.
   *
   * @param match - Match to publish
   */
  private publishAndCleanup(match: Match): void {
    this.settlementPublisher!.publishSettlementMatch(match)
      .then((messageId) => {
        if (messageId) {
          // Success: remove from memory (Redis is source of truth)
          this.removeMatch(match.matchId);
        } else {
          // Failed: keep in memory as fallback
          console.warn(
            `Settlement publish returned null for match ${match.matchId}, keeping in memory`
          );
        }
      })
      .catch((error) => {
        // Error: keep in memory as fallback
        console.error(
          `Failed to publish settlement match ${match.matchId}, keeping in memory:`,
          error
        );
      });
  }

  /**
   * Remove a match from memory storage
   *
   * @param matchId - ID of the match to remove
   */
  private removeMatch(matchId: string): void {
    const match = this.matches.get(matchId);
    if (!match) {
      return;
    }

    // Remove from main storage
    this.matches.delete(matchId);

    // Remove from lend order index
    const lendMatchIds = this.matchesByLendOrder.get(match.lendOrderId);
    if (lendMatchIds) {
      const index = lendMatchIds.indexOf(matchId);
      if (index > -1) {
        lendMatchIds.splice(index, 1);
      }
      // Clean up empty arrays
      if (lendMatchIds.length === 0) {
        this.matchesByLendOrder.delete(match.lendOrderId);
      }
    }

    // Remove from borrow order index
    const borrowMatchIds = this.matchesByBorrowOrder.get(match.borrowOrderId);
    if (borrowMatchIds) {
      const index = borrowMatchIds.indexOf(matchId);
      if (index > -1) {
        borrowMatchIds.splice(index, 1);
      }
      // Clean up empty arrays
      if (borrowMatchIds.length === 0) {
        this.matchesByBorrowOrder.delete(match.borrowOrderId);
      }
    }
  }

  /**
   * Get a match by ID
   *
   * @param matchId - The match ID
   * @returns The match if found, null otherwise
   */
  getMatch(matchId: string): Match | null {
    return this.matches.get(matchId) || null;
  }

  /**
   * Get all matches for a specific order
   *
   * @param orderId - The order ID
   * @returns Array of matches
   */
  getMatchesForOrder(orderId: string): Match[] {
    const lendMatchIds = this.matchesByLendOrder.get(orderId) || [];
    const borrowMatchIds = this.matchesByBorrowOrder.get(orderId) || [];
    const allMatchIds = [...lendMatchIds, ...borrowMatchIds];

    return allMatchIds
      .map((id) => this.matches.get(id))
      .filter((match): match is Match => match !== undefined);
  }

  /**
   * Get all matches for a lend order
   *
   * @param lendOrderId - The lend order ID
   * @returns Array of matches
   */
  getMatchesForLendOrder(lendOrderId: string): Match[] {
    const matchIds = this.matchesByLendOrder.get(lendOrderId) || [];
    return matchIds
      .map((id) => this.matches.get(id))
      .filter((match): match is Match => match !== undefined);
  }

  /**
   * Get all matches for a borrow order
   *
   * @param borrowOrderId - The borrow order ID
   * @returns Array of matches
   */
  getMatchesForBorrowOrder(borrowOrderId: string): Match[] {
    const matchIds = this.matchesByBorrowOrder.get(borrowOrderId) || [];
    return matchIds
      .map((id) => this.matches.get(id))
      .filter((match): match is Match => match !== undefined);
  }

  /**
   * Get all matches
   *
   * @returns Array of all matches
   */
  getAllMatches(): Match[] {
    return Array.from(this.matches.values());
  }

  /**
   * Get matches filtered by criteria
   *
   * @param filter - Filter criteria
   * @returns Array of matching results
   */
  getMatchesByCriteria(filter: {
    assetId?: string;
    marketId?: string;
    minRate?: number;
    maxRate?: number;
    fromTimestamp?: number;
    toTimestamp?: number;
  }): Match[] {
    let results = this.getAllMatches();

    if (filter.assetId) {
      results = results.filter((m) => m.assetId === filter.assetId);
    }

    if (filter.marketId !== undefined) {
      results = results.filter((m) => m.marketId === filter.marketId);
    }

    if (filter.minRate !== undefined) {
      results = results.filter((m) => m.rate >= filter.minRate!);
    }

    if (filter.maxRate !== undefined) {
      results = results.filter((m) => m.rate <= filter.maxRate!);
    }

    if (filter.fromTimestamp !== undefined) {
      results = results.filter((m) => m.timestamp >= filter.fromTimestamp!);
    }

    if (filter.toTimestamp !== undefined) {
      results = results.filter((m) => m.timestamp <= filter.toTimestamp!);
    }

    return results;
  }

  /**
   * Get statistics for a specific asset and market
   *
   * @param assetId - The asset ID
   * @param marketId - The market ID
   * @returns Statistics object
   */
  getStatistics(
    assetId: string,
    marketId: string
  ): {
    totalMatches: number;
    totalVolume: bigint;
    averageRate: number;
    minRate: number;
    maxRate: number;
  } | null {
    const matches = this.getMatchesByCriteria({ assetId, marketId });

    if (matches.length === 0) {
      return null;
    }

    let totalVolume = 0n;
    let totalRateWeighted = 0n;
    let minRate = Number.MAX_SAFE_INTEGER;
    let maxRate = 0;

    for (const match of matches) {
      const volume = BigInt(match.matchedAmount);
      totalVolume += volume;
      totalRateWeighted += volume * BigInt(match.rate);
      minRate = Math.min(minRate, match.rate);
      maxRate = Math.max(maxRate, match.rate);
    }

    const averageRate = totalVolume > 0n ? Number(totalRateWeighted / totalVolume) : 0;

    return {
      totalMatches: matches.length,
      totalVolume,
      averageRate,
      minRate,
      maxRate,
    };
  }

  /**
   * Clear all matches
   */
  clear(): void {
    this.matches.clear();
    this.matchesByLendOrder.clear();
    this.matchesByBorrowOrder.clear();
  }

  /**
   * Get total number of matches
   *
   * @returns Total match count
   */
  get matchCount(): number {
    return this.matches.size;
  }

  /**
   * Get all unpublished matches
   *
   * Returns matches that haven't been successfully published to the settlement publisher.
   * Used for snapshot serialization to persist matches that failed to publish.
   *
   * @returns Array of unpublished matches
   */
  getUnpublishedMatches(): Match[] {
    // All matches in memory are unpublished (they get removed after successful publish)
    return this.getAllMatches();
  }

  /**
   * Restore matches to execution engine
   *
   * Restores matches from snapshot. Used for snapshot restoration.
   * Rebuilds match indexes for quick lookups.
   *
   * @param matches - Array of matches to restore
   */
  restoreMatches(matches: Match[]): void {
    // Clear existing state
    this.clear();

    // Restore each match
    for (const match of matches) {
      // Validate match
      matchSchema.parse(match);

      // Store match
      this.matches.set(match.matchId, match);

      // Rebuild lend order index
      if (!this.matchesByLendOrder.has(match.lendOrderId)) {
        this.matchesByLendOrder.set(match.lendOrderId, []);
      }
      this.matchesByLendOrder.get(match.lendOrderId)!.push(match.matchId);

      // Rebuild borrow order index
      if (!this.matchesByBorrowOrder.has(match.borrowOrderId)) {
        this.matchesByBorrowOrder.set(match.borrowOrderId, []);
      }
      this.matchesByBorrowOrder.get(match.borrowOrderId)!.push(match.matchId);
    }
  }
}

