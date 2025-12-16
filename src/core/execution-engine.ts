import type { Match } from '../types/matches';
import { matchSchema } from '../types/matches';
import { generateMatchId } from '../utils/helpers';

/**
 * ExecutionEngine handles recording and managing match results
 */
export class ExecutionEngine {
  // Store all matches by matchId
  private matches: Map<string, Match>;

  // Index matches by order ID for quick lookups
  private matchesByLendOrder: Map<string, string[]>;
  private matchesByBorrowOrder: Map<string, string[]>;

  constructor() {
    this.matches = new Map();
    this.matchesByLendOrder = new Map();
    this.matchesByBorrowOrder = new Map();
  }

  /**
   * Record a new match
   *
   * @param params - Match parameters
   * @returns The created match
   */
  recordMatch(params: {
    lendOrderId: string;
    borrowOrderId: string;
    matchedAmount: string;
    rate: number;
    loanToken: string;
    maturity: number;
  }): Match {
    const match: Match = {
      matchId: generateMatchId(),
      lendOrderId: params.lendOrderId,
      borrowOrderId: params.borrowOrderId,
      matchedAmount: params.matchedAmount,
      rate: params.rate,
      loanToken: params.loanToken,
      maturity: params.maturity,
      timestamp: Date.now(),
    };

    // Validate match against schema
    matchSchema.parse(match);

    // Store match
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

    return match;
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
}

