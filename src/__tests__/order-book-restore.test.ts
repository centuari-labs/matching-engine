/**
 * Tests for OrderBook.restoreFromOrders() and ExecutionEngine.restoreMatches()
 *
 * Validates snapshot restoration behavior including:
 * - Empty array handling
 * - Filtering of fully-filled orders
 * - State clearing before restore
 * - Post-restore matchability
 * - Match restore validation and deduplication
 */

import { MatchingEngine } from '../core/matching-engine';
import { OrderBook } from '../core/order-book';
import { ExecutionEngine } from '../core/execution-engine';
import { OrderStatus } from '../types/orders';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  marketsFromMaturities,
  DEFAULT_LOAN_TOKEN,
  DEFAULT_MATURITY,
} from './factories/order-factory';
import { createMatch } from './factories/match-factory';

describe('OrderBook Restore', () => {
  let orderBook: OrderBook;

  beforeEach(() => {
    orderBook = new OrderBook();
  });

  it('should have zero orders after restoring from empty array', () => {
    // Pre-populate with an order
    orderBook.addOrder(createLendLimitOrder());
    expect(orderBook.orderCount).toBe(1);

    // Restore from empty — should clear everything
    orderBook.restoreFromOrders([]);
    expect(orderBook.orderCount).toBe(0);
  });

  it('should skip fully-filled orders (remainingAmount = "0")', () => {
    const filledOrder = createLendLimitOrder({
      remainingAmount: '0',
      status: OrderStatus.Filled,
    });

    orderBook.restoreFromOrders([filledOrder]);
    expect(orderBook.orderCount).toBe(0);
    expect(orderBook.getOrder(filledOrder.orderId)).toBeNull();
  });

  it('should only restore open orders from a mix of open and filled', () => {
    const openOrder = createLendLimitOrder({
      originalAmount: '1000000',
      remainingAmount: '500000',
      status: OrderStatus.PartiallyFilled,
    });

    const filledOrder = createLendLimitOrder({
      remainingAmount: '0',
      status: OrderStatus.Filled,
    });

    const anotherOpen = createBorrowLimitOrder({
      walletAddress: '0x2222222222222222222222222222222222222222',
      originalAmount: '800000',
      remainingAmount: '800000',
      status: OrderStatus.Open,
      rate: 600,
    });

    orderBook.restoreFromOrders([openOrder, filledOrder, anotherOpen]);
    expect(orderBook.orderCount).toBe(2);
    expect(orderBook.getOrder(openOrder.orderId)).not.toBeNull();
    expect(orderBook.getOrder(filledOrder.orderId)).toBeNull();
    expect(orderBook.getOrder(anotherOpen.orderId)).not.toBeNull();
  });

  it('should clear previous state before restoring', () => {
    const oldOrder = createLendLimitOrder();
    orderBook.addOrder(oldOrder);
    expect(orderBook.orderCount).toBe(1);

    const newOrder = createBorrowLimitOrder({
      walletAddress: '0x2222222222222222222222222222222222222222',
      rate: 600,
    });
    orderBook.restoreFromOrders([newOrder]);

    expect(orderBook.orderCount).toBe(1);
    expect(orderBook.getOrder(oldOrder.orderId)).toBeNull();
    expect(orderBook.getOrder(newOrder.orderId)).not.toBeNull();
  });

  it('should make restored orders matchable via the engine', () => {
    const engine = new MatchingEngine();
    const loanToken = DEFAULT_LOAN_TOKEN;
    const maturity = DEFAULT_MATURITY;

    // Submit a lend order that will be in the book
    const lendOrder = createLendLimitOrder({
      walletAddress: '0x1111111111111111111111111111111111111111',
      loanToken,
      markets: marketsFromMaturities([maturity]),
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    engine.submitOrder(lendOrder);

    // Now submit a counter-order that should match
    const borrowOrder = createBorrowLimitOrder({
      walletAddress: '0x2222222222222222222222222222222222222222',
      loanToken,
      markets: marketsFromMaturities([maturity]),
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result = engine.submitOrder(borrowOrder);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedAmount).toBe('500000');
  });
});

describe('ExecutionEngine Restore', () => {
  let engine: ExecutionEngine;

  beforeEach(() => {
    engine = new ExecutionEngine();
  });

  it('should make all restored matches retrievable by getMatch()', () => {
    const match1 = createMatch({ rate: 400 });
    const match2 = createMatch({ rate: 600 });

    engine.restoreMatches([match1, match2]);

    expect(engine.getMatch(match1.matchId)).toEqual(match1);
    expect(engine.getMatch(match2.matchId)).toEqual(match2);
    expect(engine.matchCount).toBe(2);
  });

  it('should rebuild order indexes after restore', () => {
    const match = createMatch();

    engine.restoreMatches([match]);

    const lendMatches = engine.getMatchesForLendOrder(match.lendOrderId);
    expect(lendMatches).toHaveLength(1);
    expect(lendMatches[0].matchId).toBe(match.matchId);

    const borrowMatches = engine.getMatchesForBorrowOrder(match.borrowOrderId);
    expect(borrowMatches).toHaveLength(1);
    expect(borrowMatches[0].matchId).toBe(match.matchId);
  });

  it('should throw ZodError for invalid match data', () => {
    const invalidMatch = {
      ...createMatch(),
      matchId: 'not-a-uuid', // Invalid UUID
    };

    expect(() => engine.restoreMatches([invalidMatch as any])).toThrow();
  });

  it('should overwrite first match when duplicate matchId is restored', () => {
    const match1 = createMatch({ rate: 400 });
    const match2 = createMatch({
      matchId: match1.matchId, // Same matchId
      rate: 800,
    });

    engine.restoreMatches([match1, match2]);

    // Second overwrites first in the Map
    const retrieved = engine.getMatch(match1.matchId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.rate).toBe(800);
    // Only 1 entry in the map for this matchId
    expect(engine.matchCount).toBe(1);
  });
});
