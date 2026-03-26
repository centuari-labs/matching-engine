/**
 * Execution Engine Unit Tests
 *
 * Tests for ExecutionEngine methods: filter, statistics, restore, clear.
 */

import { ExecutionEngine } from '../core/execution-engine';
import { createMatch } from './factories/match-factory';

describe('ExecutionEngine', () => {
  let engine: ExecutionEngine;

  beforeEach(() => {
    engine = new ExecutionEngine();
  });

  describe('recordMatch', () => {
    it('should record and retrieve a match', () => {
      const match = engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      expect(match.matchId).toBeDefined();
      expect(engine.getMatch(match.matchId)).toEqual(match);
      expect(engine.matchCount).toBe(1);
    });
  });

  describe('getMatch', () => {
    it('should return null for non-existent match', () => {
      expect(engine.getMatch('non-existent-id')).toBeNull();
    });
  });

  describe('getMatchesForOrder', () => {
    it('should return matches for lend order', () => {
      const match = engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      const matches = engine.getMatchesForOrder('123e4567-e89b-12d3-a456-426614174001');
      expect(matches).toHaveLength(1);
      expect(matches[0].matchId).toBe(match.matchId);
    });

    it('should return matches for borrow order', () => {
      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      const matches = engine.getMatchesForOrder('123e4567-e89b-12d3-a456-426614174002');
      expect(matches).toHaveLength(1);
    });

    it('should return empty array for unknown order', () => {
      expect(engine.getMatchesForOrder('unknown')).toEqual([]);
    });
  });

  describe('getMatchesForLendOrder', () => {
    it('should return matches only for the specified lend order', () => {
      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      expect(engine.getMatchesForLendOrder('123e4567-e89b-12d3-a456-426614174001')).toHaveLength(1);
      expect(engine.getMatchesForLendOrder('unknown')).toHaveLength(0);
    });
  });

  describe('getMatchesForBorrowOrder', () => {
    it('should return matches only for the specified borrow order', () => {
      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      expect(engine.getMatchesForBorrowOrder('123e4567-e89b-12d3-a456-426614174002')).toHaveLength(
        1
      );
      expect(engine.getMatchesForBorrowOrder('unknown')).toHaveLength(0);
    });
  });

  describe('getMatchesByCriteria', () => {
    beforeEach(() => {
      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174003',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174004',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '2000000',
        rate: 700,
        loanToken: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        maturity: 1704153600,
        borrowerIsTaker: false,
        makerFeeAmount: '2000',
        takerFeeAmount: '4000',
        lenderSettlementFeeAmount: '10000',
        borrowerSettlementFeeAmount: '10000',
      });
    });

    it('should filter by loanToken', () => {
      const results = engine.getMatchesByCriteria({
        loanToken: '0x1234567890123456789012345678901234567890',
      });
      expect(results).toHaveLength(1);
      expect(results[0].rate).toBe(500);
    });

    it('should filter by maturity', () => {
      const results = engine.getMatchesByCriteria({ maturity: 1704153600 });
      expect(results).toHaveLength(1);
      expect(results[0].rate).toBe(700);
    });

    it('should filter by minRate', () => {
      const results = engine.getMatchesByCriteria({ minRate: 600 });
      expect(results).toHaveLength(1);
      expect(results[0].rate).toBe(700);
    });

    it('should filter by maxRate', () => {
      const results = engine.getMatchesByCriteria({ maxRate: 600 });
      expect(results).toHaveLength(1);
      expect(results[0].rate).toBe(500);
    });

    it('should filter by rate range', () => {
      const results = engine.getMatchesByCriteria({ minRate: 400, maxRate: 600 });
      expect(results).toHaveLength(1);
    });

    it('should return all when no filters', () => {
      const results = engine.getMatchesByCriteria({});
      expect(results).toHaveLength(2);
    });

    it('should filter by timestamp range', () => {
      const now = Date.now();
      const results = engine.getMatchesByCriteria({
        fromTimestamp: now - 10000,
        toTimestamp: now + 10000,
      });
      expect(results).toHaveLength(2);
    });

    it('should return empty for future timestamp filter', () => {
      const results = engine.getMatchesByCriteria({
        fromTimestamp: Date.now() + 100000,
      });
      expect(results).toHaveLength(0);
    });
  });

  describe('getStatistics', () => {
    it('should return null for no matches', () => {
      const stats = engine.getStatistics('0x1234567890123456789012345678901234567890', 1704067200);
      expect(stats).toBeNull();
    });

    it('should compute statistics correctly', () => {
      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174003',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174004',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '3000000',
        rate: 700,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: false,
        makerFeeAmount: '3000',
        takerFeeAmount: '6000',
        lenderSettlementFeeAmount: '15000',
        borrowerSettlementFeeAmount: '15000',
      });

      const stats = engine.getStatistics('0x1234567890123456789012345678901234567890', 1704067200);

      expect(stats).not.toBeNull();
      expect(stats!.totalMatches).toBe(2);
      expect(stats!.totalVolume).toBe(4000000n);
      expect(stats!.minRate).toBe(500);
      expect(stats!.maxRate).toBe(700);
      // Weighted average: (1000000*500 + 3000000*700) / 4000000 = 2600000000/4000000 = 650
      expect(stats!.averageRate).toBe(650);
    });
  });

  describe('clear', () => {
    it('should remove all matches', () => {
      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      expect(engine.matchCount).toBe(1);
      engine.clear();
      expect(engine.matchCount).toBe(0);
      expect(engine.getAllMatches()).toEqual([]);
    });
  });

  describe('getUnpublishedMatches', () => {
    it('should return all in-memory matches', () => {
      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      expect(engine.getUnpublishedMatches()).toHaveLength(1);
    });
  });

  describe('restoreMatches', () => {
    it('should restore matches and rebuild indexes', () => {
      const match = createMatch();
      engine.restoreMatches([match]);

      expect(engine.matchCount).toBe(1);
      expect(engine.getMatch(match.matchId)).toEqual(match);
      expect(engine.getMatchesForLendOrder(match.lendOrderId)).toHaveLength(1);
      expect(engine.getMatchesForBorrowOrder(match.borrowOrderId)).toHaveLength(1);
    });

    it('should clear existing state before restoring', () => {
      engine.recordMatch({
        lendOrderId: '123e4567-e89b-12d3-a456-426614174001',
        borrowOrderId: '123e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      expect(engine.matchCount).toBe(1);

      const match = createMatch();
      engine.restoreMatches([match]);

      expect(engine.matchCount).toBe(1);
      expect(engine.getMatch(match.matchId)).toEqual(match);
    });

    it('should restore empty array', () => {
      engine.restoreMatches([]);
      expect(engine.matchCount).toBe(0);
    });
  });
});
