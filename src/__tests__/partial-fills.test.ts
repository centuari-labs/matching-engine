import { MatchingEngine } from '../core/matching-engine';
import type { LendLimitOrder, BorrowLimitOrder } from '../types/orders';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
} from './factories/order-factory';

describe('Partial Fills', () => {
  let engine: MatchingEngine;
  const assetId = '550e8400-e29b-41d4-a716-446655440001';
  const accountId1 = '550e8400-e29b-41d4-a716-446655440002';
  const accountId2 = '550e8400-e29b-41d4-a716-446655440003';
  const marketId = '550e8400-e29b-41d4-a716-446655440010';

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  it('should partially fill a large order with smaller orders', () => {
    // Add three small lend orders
    const lendOrder1: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now(),
      originalAmount: '300000',
      remainingAmount: '300000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    const lendOrder2: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now() + 1,
      originalAmount: '200000',
      remainingAmount: '200000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    const lendOrder3: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now() + 2,
      originalAmount: '400000',
      remainingAmount: '400000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    engine.submitOrder(lendOrder1);
    engine.submitOrder(lendOrder2);
    engine.submitOrder(lendOrder3);

    // Submit large borrow order
    const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now() + 3,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result = engine.submitOrder(borrowOrder);

    // Should match with all three lend orders
    expect(result.matches).toHaveLength(3);
    expect(result.matches[0].matchedAmount).toBe('300000');
    expect(result.matches[1].matchedAmount).toBe('200000');
    expect(result.matches[2].matchedAmount).toBe('400000');

    // Borrow order should have 100000 remaining
    expect(result.remainingOrder).not.toBeNull();
    expect(result.remainingOrder!.remainingAmount).toBe('100000');
  });

  it('should handle partial fill when maker order is larger', () => {
    // Large lend order
    const lendOrder: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now(),
      originalAmount: '5000000',
      remainingAmount: '5000000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    engine.submitOrder(lendOrder);

    // Small borrow order
    const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now() + 1,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result = engine.submitOrder(borrowOrder);

    // Should match fully
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedAmount).toBe('1000000');
    expect(result.remainingOrder).toBeNull();

    // Lend order should still be in the book with remaining amount
    const snapshot = engine.getOrderBook(assetId, marketId, 10);
    expect(snapshot.lendOrders).toHaveLength(1);
    expect(snapshot.lendOrders[0].amount).toBe('4000000');
  });

  it('should handle multiple partial fills on the same order', () => {
    // Submit a large lend order
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

    engine.submitOrder(lendOrder);

    // First partial fill
    const borrowOrder1: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now() + 1,
      originalAmount: '300000',
      remainingAmount: '300000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result1 = engine.submitOrder(borrowOrder1);
    expect(result1.matches).toHaveLength(1);
    expect(result1.matches[0].lendOrderId).toBe(lendOrder.orderId);

    // Second partial fill
    const borrowOrder2: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now() + 2,
      originalAmount: '400000',
      remainingAmount: '400000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result2 = engine.submitOrder(borrowOrder2);
    expect(result2.matches).toHaveLength(1);
    expect(result2.matches[0].lendOrderId).toBe(lendOrder.orderId);

    // Third partial fill - complete the order
    const borrowOrder3: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now() + 3,
      originalAmount: '300000',
      remainingAmount: '300000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result3 = engine.submitOrder(borrowOrder3);
    expect(result3.matches).toHaveLength(1);
    expect(result3.matches[0].lendOrderId).toBe(lendOrder.orderId);

    // Original lend order should now be fully filled and removed
    const snapshot = engine.getOrderBook(assetId, marketId, 10);
    expect(snapshot.lendOrders).toHaveLength(0);

    // Check match history
    const matches = engine.getMatches(lendOrder.orderId);
    expect(matches).toHaveLength(3);

    const totalMatched = matches.reduce(
      (sum, match) => sum + BigInt(match.matchedAmount),
      0n
    );
    expect(totalMatched.toString()).toBe('1000000');
  });

  it('should handle exact amount matching', () => {
    const amount = '1234567890';

    const lendOrder: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now(),
      originalAmount: amount,
      remainingAmount: amount,
      settlementFeeAmount: '10000',
      rate: 500,
    });

    const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now() + 1,
      originalAmount: amount,
      remainingAmount: amount,
      settlementFeeAmount: '10000',
      rate: 600,
    });

    engine.submitOrder(lendOrder);
    const result = engine.submitOrder(borrowOrder);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedAmount).toBe(amount);
    expect(result.remainingOrder).toBeNull();

    // Both orders should be removed from order book
    const snapshot = engine.getOrderBook(assetId, marketId, 10);
    expect(snapshot.lendOrders).toHaveLength(0);
    expect(snapshot.borrowOrders).toHaveLength(0);
  });

  it('should handle very large numbers', () => {
    const largeAmount = '999999999999999999999999';

    const lendOrder: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now(),
      originalAmount: largeAmount,
      remainingAmount: largeAmount,
      settlementFeeAmount: '10000',
      rate: 500,
    });

    const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId],
      timestamp: Date.now() + 1,
      originalAmount: '1000',
      remainingAmount: '1000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    engine.submitOrder(lendOrder);
    const result = engine.submitOrder(borrowOrder);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedAmount).toBe('1000');

    // Lend order should still exist with large remaining amount
    const snapshot = engine.getOrderBook(assetId, marketId, 10);
    expect(snapshot.lendOrders).toHaveLength(1);
    expect(BigInt(snapshot.lendOrders[0].amount)).toBe(BigInt(largeAmount) - BigInt('1000'));
  });
});

