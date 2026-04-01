/**
 * Tests for ExecutionEngine.getMatchesByCriteria() and getStatistics()
 *
 * Validates filtering, statistics computation, and edge cases for query methods.
 */

import { ExecutionEngine } from '../core/execution-engine';
import { createMatch } from './factories/match-factory';
import {
  DEFAULT_LOAN_TOKEN,
  DEFAULT_MATURITY,
} from './factories/order-factory';

describe('ExecutionEngine Queries', () => {
  let engine: ExecutionEngine;

  beforeEach(() => {
    engine = new ExecutionEngine();
  });

  describe('getMatchesByCriteria', () => {
    it('should return empty array from empty engine', () => {
      const results = engine.getMatchesByCriteria({});
      expect(results).toEqual([]);
    });

    it('should filter by loanToken', () => {
      const tokenA = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const tokenB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      const matchA = createMatch({ loanToken: tokenA });
      const matchB = createMatch({ loanToken: tokenB });

      engine.restoreMatches([matchA, matchB]);

      const results = engine.getMatchesByCriteria({ loanToken: tokenA });
      expect(results).toHaveLength(1);
      expect(results[0].loanToken).toBe(tokenA);
    });

    it('should filter by minRate and maxRate range', () => {
      const lowRate = createMatch({ rate: 200 });
      const midRate = createMatch({ rate: 500 });
      const highRate = createMatch({ rate: 800 });

      engine.restoreMatches([lowRate, midRate, highRate]);

      const results = engine.getMatchesByCriteria({ minRate: 300, maxRate: 600 });
      expect(results).toHaveLength(1);
      expect(results[0].rate).toBe(500);
    });

    it('should return empty array when minRate > maxRate (conflicting range)', () => {
      const match = createMatch({ rate: 500 });
      engine.restoreMatches([match]);

      const results = engine.getMatchesByCriteria({ minRate: 800, maxRate: 200 });
      expect(results).toHaveLength(0);
    });

    it('should filter by timestamp range', () => {
      const now = Date.now();
      const early = createMatch({ timestamp: now - 10000 });
      const mid = createMatch({ timestamp: now });
      const late = createMatch({ timestamp: now + 10000 });

      engine.restoreMatches([early, mid, late]);

      const results = engine.getMatchesByCriteria({
        fromTimestamp: now - 5000,
        toTimestamp: now + 5000,
      });
      expect(results).toHaveLength(1);
      expect(results[0].matchId).toBe(mid.matchId);
    });

    it('should combine multiple filters', () => {
      const target = createMatch({
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        rate: 500,
      });
      const wrongToken = createMatch({
        loanToken: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        maturity: DEFAULT_MATURITY,
        rate: 500,
      });
      const wrongRate = createMatch({
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        rate: 100,
      });

      engine.restoreMatches([target, wrongToken, wrongRate]);

      const results = engine.getMatchesByCriteria({
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        minRate: 400,
        maxRate: 600,
      });
      expect(results).toHaveLength(1);
      expect(results[0].matchId).toBe(target.matchId);
    });
  });

  describe('getStatistics', () => {
    it('should return null when no matches exist for token/maturity', () => {
      const stats = engine.getStatistics(DEFAULT_LOAN_TOKEN, DEFAULT_MATURITY);
      expect(stats).toBeNull();
    });

    it('should return correct stats for a single match', () => {
      const match = createMatch({
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        matchedAmount: '1000000',
        rate: 500,
      });

      engine.restoreMatches([match]);

      const stats = engine.getStatistics(DEFAULT_LOAN_TOKEN, DEFAULT_MATURITY);
      expect(stats).not.toBeNull();
      expect(stats!.totalMatches).toBe(1);
      expect(stats!.totalVolume).toBe(1000000n);
      expect(stats!.averageRate).toBe(500);
      expect(stats!.minRate).toBe(500);
      expect(stats!.maxRate).toBe(500);
    });

    it('should compute volume-weighted average rate for multiple matches', () => {
      // Match A: 1,000,000 at rate 400
      // Match B: 3,000,000 at rate 600
      // Weighted avg = (1M*400 + 3M*600) / (1M+3M) = 2,200,000,000 / 4,000,000 = 550
      const matchA = createMatch({
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        matchedAmount: '1000000',
        rate: 400,
      });
      const matchB = createMatch({
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        matchedAmount: '3000000',
        rate: 600,
      });

      engine.restoreMatches([matchA, matchB]);

      const stats = engine.getStatistics(DEFAULT_LOAN_TOKEN, DEFAULT_MATURITY);
      expect(stats).not.toBeNull();
      expect(stats!.totalMatches).toBe(2);
      expect(stats!.totalVolume).toBe(4000000n);
      expect(stats!.averageRate).toBe(550);
      expect(stats!.minRate).toBe(400);
      expect(stats!.maxRate).toBe(600);
    });

    it('should compute correct totalVolume as BigInt sum', () => {
      const match1 = createMatch({
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        matchedAmount: '500000',
        rate: 300,
      });
      const match2 = createMatch({
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        matchedAmount: '750000',
        rate: 700,
      });

      engine.restoreMatches([match1, match2]);

      const stats = engine.getStatistics(DEFAULT_LOAN_TOKEN, DEFAULT_MATURITY);
      expect(stats).not.toBeNull();
      expect(stats!.totalVolume).toBe(1250000n);
    });
  });
});
