/**
 * Settlement Publisher Integration Tests
 *
 * Tests for the SettlementPublisher integration with ExecutionEngine.
 * These tests verify:
 * - Matches are published to the settlement publisher
 * - Memory cleanup on successful publish
 * - Fallback behavior on failed publish
 */

import { ExecutionEngine } from '../core/execution-engine';
import { MatchingEngine } from '../core/matching-engine';
import type { SettlementPublisher } from '../types/settlement';
import type { Match } from '../types/matches';
import { generateOrderId, calculateMakerFee, calculateTakerFee } from '../utils/helpers';
import type { LendLimitOrder, BorrowLimitOrder } from '../types/orders';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  DEFAULT_ASSET_ID,
  DEFAULT_MARKET_ID,
} from './factories/order-factory';

/**
 * Mock implementation of SettlementPublisher for testing
 */
class MockSettlementPublisher implements SettlementPublisher {
  public publishedMatches: Match[] = [];
  public shouldFail = false;
  public shouldReturnNull = false;
  public publishDelay = 0;

  async publishSettlementMatch(match: Match): Promise<string | null> {
    if (this.publishDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.publishDelay));
    }

    if (this.shouldFail) {
      throw new Error('Mock publish failure');
    }

    if (this.shouldReturnNull) {
      return null;
    }

    this.publishedMatches.push(match);
    return `mock-message-id-${match.matchId}`;
  }

  reset(): void {
    this.publishedMatches = [];
    this.shouldFail = false;
    this.shouldReturnNull = false;
    this.publishDelay = 0;
  }
}

describe('SettlementPublisher Integration', () => {
  const assetId = DEFAULT_ASSET_ID;
  const accountId1 = '550e8400-e29b-41d4-a716-446655440002';
  const accountId2 = '550e8400-e29b-41d4-a716-446655440003';
  const marketId = DEFAULT_MARKET_ID;

  describe('ExecutionEngine with SettlementPublisher', () => {
    let mockPublisher: MockSettlementPublisher;
    let executionEngine: ExecutionEngine;

    beforeEach(() => {
      mockPublisher = new MockSettlementPublisher();
      executionEngine = new ExecutionEngine(mockPublisher);
    });

    afterEach(() => {
      mockPublisher.reset();
    });

    it('should publish match to settlement publisher when recording', async () => {
      const matchedAmount = '1000000';
      const match = executionEngine.recordMatch({
        lendOrderId: generateOrderId(),
        borrowOrderId: generateOrderId(),
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount,
        rate: 500,
        assetId,
        marketId,
        borrowerIsTaker: true,
        makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      // Wait for async publish to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPublisher.publishedMatches).toHaveLength(1);
      expect(mockPublisher.publishedMatches[0].matchId).toBe(match.matchId);
    });

    it('should include all match fields in published message', async () => {
      const lendOrderId = generateOrderId();
      const borrowOrderId = generateOrderId();
      const matchedAmount = '5000000';

      executionEngine.recordMatch({
        lendOrderId,
        borrowOrderId,
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount,
        rate: 750,
        assetId,
        marketId,
        borrowerIsTaker: false,
        makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '6000',
        borrowerSettlementFeeAmount: '4000',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const publishedMatch = mockPublisher.publishedMatches[0];
      expect(publishedMatch.lendOrderId).toBe(lendOrderId);
      expect(publishedMatch.borrowOrderId).toBe(borrowOrderId);
      expect(publishedMatch.lenderAccountId).toBe(accountId1);
      expect(publishedMatch.borrowerAccountId).toBe(accountId2);
      expect(publishedMatch.matchedAmount).toBe('5000000');
      expect(publishedMatch.rate).toBe(750);
      expect(publishedMatch.assetId).toBe(assetId);
      expect(publishedMatch.marketId).toBe(marketId);
      expect(publishedMatch.borrowerIsTaker).toBe(false);
      expect(publishedMatch.timestamp).toBeDefined();
      expect(publishedMatch.matchId).toBeDefined();
    });

    it('should remove match from memory after successful publish', async () => {
      const matchedAmount = '1000000';
      const match = executionEngine.recordMatch({
        lendOrderId: generateOrderId(),
        borrowOrderId: generateOrderId(),
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount,
        rate: 500,
        assetId,
        marketId,
        borrowerIsTaker: true,
        makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      // Match should be in memory immediately
      expect(executionEngine.getMatch(match.matchId)).not.toBeNull();
      expect(executionEngine.matchCount).toBe(1);

      // Wait for async publish and cleanup
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Match should be removed from memory after successful publish
      expect(executionEngine.getMatch(match.matchId)).toBeNull();
      expect(executionEngine.matchCount).toBe(0);
    });

    it('should keep match in memory when publish returns null', async () => {
      mockPublisher.shouldReturnNull = true;

      const matchedAmount = '1000000';
      const match = executionEngine.recordMatch({
        lendOrderId: generateOrderId(),
        borrowOrderId: generateOrderId(),
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount,
        rate: 500,
        assetId,
        marketId,
        borrowerIsTaker: true,
        makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      // Wait for async publish attempt
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Match should remain in memory as fallback
      expect(executionEngine.getMatch(match.matchId)).not.toBeNull();
      expect(executionEngine.matchCount).toBe(1);
    });

    it('should keep match in memory when publish throws error', async () => {
      mockPublisher.shouldFail = true;

      // Suppress console.error for this test
      const originalError = console.error;
      console.error = jest.fn();

      const matchedAmount = '1000000';
      const match = executionEngine.recordMatch({
        lendOrderId: generateOrderId(),
        borrowOrderId: generateOrderId(),
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount,
        rate: 500,
        assetId,
        marketId,
        borrowerIsTaker: true,
        makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      // Wait for async publish attempt
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Match should remain in memory as fallback
      expect(executionEngine.getMatch(match.matchId)).not.toBeNull();
      expect(executionEngine.matchCount).toBe(1);

      console.error = originalError;
    });

    it('should publish multiple matches independently', async () => {
      const matchedAmount1 = '1000000';
      executionEngine.recordMatch({
        lendOrderId: generateOrderId(),
        borrowOrderId: generateOrderId(),
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount: matchedAmount1,
        rate: 500,
        assetId,
        marketId,
        borrowerIsTaker: true,
        makerFeeAmount: calculateMakerFee(matchedAmount1),
        takerFeeAmount: calculateTakerFee(matchedAmount1),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      const matchedAmount2 = '2000000';
      executionEngine.recordMatch({
        lendOrderId: generateOrderId(),
        borrowOrderId: generateOrderId(),
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount: matchedAmount2,
        rate: 600,
        assetId,
        marketId,
        borrowerIsTaker: false,
        makerFeeAmount: calculateMakerFee(matchedAmount2),
        takerFeeAmount: calculateTakerFee(matchedAmount2),
        lenderSettlementFeeAmount: '6000',
        borrowerSettlementFeeAmount: '4000',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockPublisher.publishedMatches).toHaveLength(2);
      expect(executionEngine.matchCount).toBe(0);
    });

    it('should clean up order indexes when match is removed', async () => {
      const lendOrderId = generateOrderId();
      const borrowOrderId = generateOrderId();
      const matchedAmount = '1000000';

      executionEngine.recordMatch({
        lendOrderId,
        borrowOrderId,
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount,
        rate: 500,
        assetId,
        marketId,
        borrowerIsTaker: true,
        makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      // Matches should be indexed
      expect(executionEngine.getMatchesForLendOrder(lendOrderId)).toHaveLength(1);
      expect(executionEngine.getMatchesForBorrowOrder(borrowOrderId)).toHaveLength(1);

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Indexes should be cleaned up
      expect(executionEngine.getMatchesForLendOrder(lendOrderId)).toHaveLength(0);
      expect(executionEngine.getMatchesForBorrowOrder(borrowOrderId)).toHaveLength(0);
    });
  });

  describe('ExecutionEngine without SettlementPublisher', () => {
    let executionEngine: ExecutionEngine;

    beforeEach(() => {
      executionEngine = new ExecutionEngine();
    });

    it('should work without settlement publisher', () => {
      const matchedAmount = '1000000';
      const match = executionEngine.recordMatch({
        lendOrderId: generateOrderId(),
        borrowOrderId: generateOrderId(),
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount,
        rate: 500,
        assetId,
        marketId,
        borrowerIsTaker: true,
        makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      expect(match).toBeDefined();
      expect(match.matchId).toBeDefined();
    });

    it('should keep matches in memory when no publisher', async () => {
      const matchedAmount = '1000000';
      const match = executionEngine.recordMatch({
        lendOrderId: generateOrderId(),
        borrowOrderId: generateOrderId(),
        lenderAccountId: accountId1,
        borrowerAccountId: accountId2,
        matchedAmount,
        rate: 500,
        assetId,
        marketId,
        borrowerIsTaker: true,
        makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Match should remain in memory (no publisher to clean up)
      expect(executionEngine.getMatch(match.matchId)).not.toBeNull();
      expect(executionEngine.matchCount).toBe(1);
    });
  });

  describe('MatchingEngine with SettlementPublisher', () => {
    let mockPublisher: MockSettlementPublisher;
    let matchingEngine: MatchingEngine;

    beforeEach(() => {
      mockPublisher = new MockSettlementPublisher();
      matchingEngine = new MatchingEngine(mockPublisher);
    });

    afterEach(() => {
      mockPublisher.reset();
    });

    it('should publish matches created through order matching', async () => {
      // Create lend limit order
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        accountId: accountId1,
        assetId,
        marketIds: [marketId],
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 500,
        settlementFeeAmount: '10000',
      });

      // Create borrow limit order that will match
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        accountId: accountId2,
        assetId,
        marketIds: [marketId],
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 600,
        settlementFeeAmount: '10000',
      });

      // Submit lend order first (becomes maker)
      matchingEngine.submitOrder(lendOrder);

      // Submit borrow order (will match)
      const result = matchingEngine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);

      // Wait for async publish
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify match was published
      expect(mockPublisher.publishedMatches).toHaveLength(1);
      expect(mockPublisher.publishedMatches[0].lendOrderId).toBe(lendOrder.orderId);
      expect(mockPublisher.publishedMatches[0].borrowOrderId).toBe(borrowOrder.orderId);
      expect(mockPublisher.publishedMatches[0].lenderAccountId).toBe(accountId1);
      expect(mockPublisher.publishedMatches[0].borrowerAccountId).toBe(accountId2);
    });

    it('should publish partial fill matches', async () => {
      // Create lend order for 2000000
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        accountId: accountId1,
        assetId,
        marketIds: [marketId],
        timestamp: Date.now(),
        originalAmount: '2000000',
        remainingAmount: '2000000',
        rate: 500,
        settlementFeeAmount: '10000',
      });

      // Create borrow order for 1000000 (partial match)
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        accountId: accountId2,
        assetId,
        marketIds: [marketId],
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 600,
        settlementFeeAmount: '10000',
      });

      matchingEngine.submitOrder(lendOrder);
      const result = matchingEngine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].matchedAmount).toBe('1000000');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockPublisher.publishedMatches).toHaveLength(1);
      expect(mockPublisher.publishedMatches[0].matchedAmount).toBe('1000000');
    });

    it('should handle publisher failure gracefully during matching', async () => {
      mockPublisher.shouldFail = true;

      // Suppress console.error
      const originalError = console.error;
      console.error = jest.fn();

      const lendOrder: LendLimitOrder = createLendLimitOrder({
        accountId: accountId1,
        assetId,
        marketIds: [marketId],
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 500,
        settlementFeeAmount: '10000',
      });

      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        accountId: accountId2,
        assetId,
        marketIds: [marketId],
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 600,
        settlementFeeAmount: '10000',
      });

      matchingEngine.submitOrder(lendOrder);
      const result = matchingEngine.submitOrder(borrowOrder);

      // Matching should succeed even if publish fails
      expect(result.matches).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Match should remain in memory (publish failed)
      const matches = matchingEngine.getMatches(lendOrder.orderId);
      expect(matches).toHaveLength(1);

      console.error = originalError;
    });
  });

  describe('Memory efficiency', () => {
    let mockPublisher: MockSettlementPublisher;
    let executionEngine: ExecutionEngine;

    beforeEach(() => {
      mockPublisher = new MockSettlementPublisher();
      executionEngine = new ExecutionEngine(mockPublisher);
    });

    it('should remove multiple matches from memory after successful publishes', async () => {
      // Create multiple matches
      const matchedAmount = '1000000';
      for (let i = 0; i < 10; i++) {
        executionEngine.recordMatch({
          lendOrderId: generateOrderId(),
          borrowOrderId: generateOrderId(),
          lenderAccountId: accountId1,
          borrowerAccountId: accountId2,
          matchedAmount,
          rate: 500 + i,
          assetId,
          marketId,
          borrowerIsTaker: true,
          makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
        });
      }

      // Initially all matches are in memory
      expect(executionEngine.matchCount).toBe(10);

      // Wait for all publishes to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // All matches should be removed from memory
      expect(executionEngine.matchCount).toBe(0);
      expect(mockPublisher.publishedMatches).toHaveLength(10);
    });

    it('should only keep failed publishes in memory', async () => {
      // First 5 succeed, last 5 fail
      let callCount = 0;
      const originalPublish = mockPublisher.publishSettlementMatch.bind(mockPublisher);
      mockPublisher.publishSettlementMatch = async (match: Match) => {
        callCount++;
        if (callCount > 5) {
          return null; // Simulate failure
        }
        return originalPublish(match);
      };

      // Suppress console.warn
      const originalWarn = console.warn;
      console.warn = jest.fn();

      // Create 10 matches
      const matchedAmount = '1000000';
      for (let i = 0; i < 10; i++) {
        executionEngine.recordMatch({
          lendOrderId: generateOrderId(),
          borrowOrderId: generateOrderId(),
          lenderAccountId: accountId1,
          borrowerAccountId: accountId2,
          matchedAmount,
          rate: 500 + i,
          assetId,
          marketId,
          borrowerIsTaker: true,
          makerFeeAmount: calculateMakerFee(matchedAmount),
        takerFeeAmount: calculateTakerFee(matchedAmount),
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Only failed publishes should remain in memory
      expect(executionEngine.matchCount).toBe(5);
      expect(mockPublisher.publishedMatches).toHaveLength(5);

      console.warn = originalWarn;
    });
  });
});
