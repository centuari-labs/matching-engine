import type { Match } from '../types/matches';
import { matchSchema } from '../types/matches';
import type { SettlementPublisher } from '../types/settlement';
import type { BufferStats, BufferEventHandler } from '../types/buffer';
import { generateMatchId } from '../utils/helpers';
import { createLogger } from '../utils/logger';

const log = createLogger('execution-engine');

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
  private matchesByLendOrder: Map<string, Set<string>>;
  private matchesByBorrowOrder: Map<string, Set<string>>;

  /** Optional publisher for settlement matches */
  private settlementPublisher?: SettlementPublisher;

  /** Optional handler for buffer lifecycle events (retry, threshold, disk spill) */
  private bufferEventHandler?: BufferEventHandler;

  /** Warning thresholds for buffer size monitoring (sorted ascending) */
  private warningThresholds: number[];

  /** Disk spill threshold */
  private diskSpillThreshold: number;

  /** Tracks which matchIds are currently in an active retry cycle */
  private retryingMatchIds: Set<string>;

  /** Tracks the last warning threshold that was reported to avoid duplicate alerts */
  private lastReportedThreshold: number | null;

  /** Maximum buffer size (0 = unlimited) */
  private maxBufferSize: number;

  /**
   * Create a new ExecutionEngine instance
   *
   * @param settlementPublisher - Optional publisher for settlement matches
   * @param bufferEventHandler - Optional handler for buffer events (retry, thresholds, disk spill)
   * @param warningThresholds - Buffer size thresholds that trigger warnings
   * @param diskSpillThreshold - Buffer size that triggers disk spill
   * @param maxBufferSize - Hard cap on buffer size (0 = unlimited)
   */
  constructor(
    settlementPublisher?: SettlementPublisher,
    bufferEventHandler?: BufferEventHandler,
    warningThresholds: number[] = [],
    diskSpillThreshold: number = 0,
    maxBufferSize: number = 0
  ) {
    this.matches = new Map();
    this.matchesByLendOrder = new Map();
    this.matchesByBorrowOrder = new Map();
    this.settlementPublisher = settlementPublisher;
    this.bufferEventHandler = bufferEventHandler;
    this.warningThresholds = [...warningThresholds].sort((a, b) => a - b);
    this.diskSpillThreshold = diskSpillThreshold;
    this.retryingMatchIds = new Set();
    this.lastReportedThreshold = null;
    this.maxBufferSize = maxBufferSize;
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
    marketId: string;
    lendOrderId: string;
    borrowOrderId: string;
    lenderWallet: string;
    borrowerWallet: string;
    matchedAmount: string;
    rate: number;
    loanToken: string;
    maturity: number;
    borrowerIsTaker: boolean;
    makerFeeAmount: string;
    takerFeeAmount: string;
    lenderSettlementFeeAmount: string;
    borrowerSettlementFeeAmount: string;
  }): Match {
    // Reject new matches when buffer is full to apply backpressure
    if (this.maxBufferSize > 0 && this.matches.size >= this.maxBufferSize) {
      throw new Error(
        `Buffer full: ${this.matches.size} matches (max ${this.maxBufferSize}). Rejecting new match.`
      );
    }

    const match: Match = {
      matchId: generateMatchId(),
      marketId: params.marketId,
      lendOrderId: params.lendOrderId,
      borrowOrderId: params.borrowOrderId,
      lenderWallet: params.lenderWallet,
      borrowerWallet: params.borrowerWallet,
      matchedAmount: params.matchedAmount,
      rate: params.rate,
      loanToken: params.loanToken,
      maturity: params.maturity,
      timestamp: Date.now(),
      borrowerIsTaker: params.borrowerIsTaker,
      makerFeeAmount: params.makerFeeAmount,
      takerFeeAmount: params.takerFeeAmount,
      lenderSettlementFeeAmount: params.lenderSettlementFeeAmount,
      borrowerSettlementFeeAmount: params.borrowerSettlementFeeAmount,
    };

    // Log match creation for observability and debugging
    log.info(
      {
        matchId: match.matchId,
        marketId: match.marketId,
        lendOrderId: match.lendOrderId,
        borrowOrderId: match.borrowOrderId,
        lenderWallet: match.lenderWallet,
        borrowerWallet: match.borrowerWallet,
        matchedAmount: match.matchedAmount,
        rate: match.rate,
        loanToken: match.loanToken,
        maturity: match.maturity,
        borrowerIsTaker: match.borrowerIsTaker,
        makerFeeAmount: match.makerFeeAmount,
        takerFeeAmount: match.takerFeeAmount,
        lenderSettlementFeeAmount: match.lenderSettlementFeeAmount,
        borrowerSettlementFeeAmount: match.borrowerSettlementFeeAmount,
      },
      'match created'
    );

    // Validate match against schema
    matchSchema.parse(match);

    // Store match in memory (temporary buffer)
    this.matches.set(match.matchId, match);

    // Index by lend order
    if (!this.matchesByLendOrder.has(params.lendOrderId)) {
      this.matchesByLendOrder.set(params.lendOrderId, new Set());
    }
    this.matchesByLendOrder.get(params.lendOrderId)!.add(match.matchId);

    // Index by borrow order
    if (!this.matchesByBorrowOrder.has(params.borrowOrderId)) {
      this.matchesByBorrowOrder.set(params.borrowOrderId, new Set());
    }
    this.matchesByBorrowOrder.get(params.borrowOrderId)!.add(match.matchId);

    // Check buffer thresholds after storing
    this.checkThresholds();

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
          this.retryingMatchIds.delete(match.matchId);
          this.bufferEventHandler?.onPublishSucceeded(match.matchId);
        } else {
          // Failed: keep in memory, notify handler for retry
          log.warn(
            { matchId: match.matchId },
            'settlement publish returned null, keeping in memory'
          );
          this.bufferEventHandler?.onPublishFailed(match);
        }
      })
      .catch((error) => {
        // Error: keep in memory, notify handler for retry
        log.error(
          { matchId: match.matchId, err: error },
          'failed to publish settlement match, keeping in memory'
        );
        this.bufferEventHandler?.onPublishFailed(match);
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

    // Remove from lend order index (O(1) with Set)
    const lendMatchIds = this.matchesByLendOrder.get(match.lendOrderId);
    if (lendMatchIds) {
      lendMatchIds.delete(matchId);
      if (lendMatchIds.size === 0) {
        this.matchesByLendOrder.delete(match.lendOrderId);
      }
    }

    // Remove from borrow order index (O(1) with Set)
    const borrowMatchIds = this.matchesByBorrowOrder.get(match.borrowOrderId);
    if (borrowMatchIds) {
      borrowMatchIds.delete(matchId);
      if (borrowMatchIds.size === 0) {
        this.matchesByBorrowOrder.delete(match.borrowOrderId);
      }
    }
  }

  /**
   * Retry publishing a match that previously failed
   *
   * Called by the retry service when it's time to re-attempt publishing.
   * No-ops if the match has already been published and removed.
   *
   * @param matchId - ID of the match to retry
   */
  retryPublish(matchId: string): void {
    const match = this.matches.get(matchId);
    if (!match || !this.settlementPublisher) return;
    this.publishAndCleanup(match);
  }

  /**
   * Mark a match as currently being retried
   *
   * @param matchId - ID of the match
   */
  markRetrying(matchId: string): void {
    if (this.matches.has(matchId)) {
      this.retryingMatchIds.add(matchId);
    }
  }

  /**
   * Unmark a match from the retrying set
   *
   * @param matchId - ID of the match
   */
  unmarkRetrying(matchId: string): void {
    this.retryingMatchIds.delete(matchId);
  }

  /**
   * Get buffer statistics for monitoring
   *
   * @returns Current buffer statistics
   */
  getBufferStats(): BufferStats {
    const now = Date.now();
    let oldestTimestamp = now;

    for (const match of this.matches.values()) {
      if (match.timestamp < oldestTimestamp) {
        oldestTimestamp = match.timestamp;
      }
    }

    const totalMatches = this.matches.size;

    return {
      totalMatches,
      retryingCount: this.retryingMatchIds.size,
      oldestMatchAge: totalMatches > 0 ? now - oldestTimestamp : 0,
      thresholdBreached: this.getBreachedThreshold(totalMatches),
    };
  }

  /**
   * Merge matches into the buffer without clearing existing state
   *
   * Used to load disk-spilled matches on startup. Deduplicates by matchId.
   *
   * @param matches - Matches to merge
   */
  mergeMatches(matches: Match[]): void {
    for (const match of matches) {
      if (this.matches.has(match.matchId)) {
        continue;
      }

      matchSchema.parse(match);

      this.matches.set(match.matchId, match);

      if (!this.matchesByLendOrder.has(match.lendOrderId)) {
        this.matchesByLendOrder.set(match.lendOrderId, new Set());
      }
      this.matchesByLendOrder.get(match.lendOrderId)!.add(match.matchId);

      if (!this.matchesByBorrowOrder.has(match.borrowOrderId)) {
        this.matchesByBorrowOrder.set(match.borrowOrderId, new Set());
      }
      this.matchesByBorrowOrder.get(match.borrowOrderId)!.add(match.matchId);
    }
  }

  /**
   * Get the highest warning threshold breached by the current buffer size
   *
   * @param size - Current buffer size
   * @returns Highest threshold breached, or null if none
   */
  private getBreachedThreshold(size: number): number | null {
    let breached: number | null = null;
    for (const threshold of this.warningThresholds) {
      if (size >= threshold) {
        breached = threshold;
      }
    }
    return breached;
  }

  /**
   * Check buffer thresholds and fire callbacks if new thresholds are crossed
   */
  private checkThresholds(): void {
    if (!this.bufferEventHandler) return;

    const size = this.matches.size;
    const breached = this.getBreachedThreshold(size);

    // Fire warning if a new (higher) threshold was crossed
    if (breached !== null && breached !== this.lastReportedThreshold) {
      this.lastReportedThreshold = breached;
      this.bufferEventHandler.onThresholdBreached(size, breached);
    }

    // Reset tracking when buffer shrinks below all thresholds
    if (breached === null && this.lastReportedThreshold !== null) {
      this.lastReportedThreshold = null;
    }

    // Fire disk spill if threshold is set and exceeded
    if (this.diskSpillThreshold > 0 && size >= this.diskSpillThreshold) {
      this.bufferEventHandler.onDiskSpillNeeded(this.getAllMatches());
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
    const lendMatchIds = this.matchesByLendOrder.get(orderId);
    const borrowMatchIds = this.matchesByBorrowOrder.get(orderId);
    const allMatchIds = [...(lendMatchIds ?? []), ...(borrowMatchIds ?? [])];

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
    const matchIds = this.matchesByLendOrder.get(lendOrderId);
    if (!matchIds) return [];
    return [...matchIds]
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
    const matchIds = this.matchesByBorrowOrder.get(borrowOrderId);
    if (!matchIds) return [];
    return [...matchIds]
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
    loanToken?: string;
    maturity?: number;
    minRate?: number;
    maxRate?: number;
    fromTimestamp?: number;
    toTimestamp?: number;
  }): Match[] {
    let results = this.getAllMatches();

    if (filter.loanToken) {
      results = results.filter((m) => m.loanToken === filter.loanToken);
    }

    if (filter.maturity !== undefined) {
      results = results.filter((m) => m.maturity === filter.maturity);
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
   * Get statistics for a specific loan token and maturity
   *
   * @param loanToken - The loan token address
   * @param maturity - The maturity date
   * @returns Statistics object
   */
  getStatistics(
    loanToken: string,
    maturity: number
  ): {
    totalMatches: number;
    totalVolume: bigint;
    averageRate: number;
    minRate: number;
    maxRate: number;
  } | null {
    const matches = this.getMatchesByCriteria({ loanToken, maturity });

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
        this.matchesByLendOrder.set(match.lendOrderId, new Set());
      }
      this.matchesByLendOrder.get(match.lendOrderId)!.add(match.matchId);

      // Rebuild borrow order index
      if (!this.matchesByBorrowOrder.has(match.borrowOrderId)) {
        this.matchesByBorrowOrder.set(match.borrowOrderId, new Set());
      }
      this.matchesByBorrowOrder.get(match.borrowOrderId)!.add(match.matchId);
    }
  }
}
