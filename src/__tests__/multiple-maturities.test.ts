import { MatchingEngine } from '../core/matching-engine';
import type { LendLimitOrder, BorrowLimitOrder } from '../types/orders';
import { OrderSide } from '../types/orders';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
} from './factories/order-factory';

describe('Multiple Markets Matching', () => {
  let engine: MatchingEngine;
  const assetId = '550e8400-e29b-41d4-a716-446655440001';
  const accountId1 = '550e8400-e29b-41d4-a716-446655440002';
  const accountId2 = '550e8400-e29b-41d4-a716-446655440003';
  const marketId1 = '550e8400-e29b-41d4-a716-446655440010';
  const marketId2 = '550e8400-e29b-41d4-a716-446655440011';
  const marketId3 = '550e8400-e29b-41d4-a716-446655440012';

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  it('should match orders with single maturity across multiple order maturities', () => {
    // Lend order with single maturity
    const lendOrder: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId1],
      timestamp: Date.now(),
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    engine.submitOrder(lendOrder);

    // Borrow order with multiple maturities including maturity1
    const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId1, marketId2, marketId3],
      timestamp: Date.now() + 1,
      side: OrderSide.Borrow,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result = engine.submitOrder(borrowOrder);

    // Should match on maturity1
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].marketId).toBe(marketId1);
    expect(result.matches[0].matchedAmount).toBe('500000');
    expect(result.remainingOrder).toBeNull();
  });

  it('should match across multiple maturities when sufficient liquidity exists', () => {
    // Add lend orders at different maturities
    const lendOrder1: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId1],
      timestamp: Date.now(),
      originalAmount: '300000',
      remainingAmount: '300000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    const lendOrder2: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId2],
      timestamp: Date.now() + 1,
      originalAmount: '400000',
      remainingAmount: '400000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    const lendOrder3: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId3],
      timestamp: Date.now() + 2,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    engine.submitOrder(lendOrder1);
    engine.submitOrder(lendOrder2);
    engine.submitOrder(lendOrder3);

    // Borrow order matching all three maturities
    const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId1, marketId2, marketId3],
      timestamp: Date.now() + 3,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result = engine.submitOrder(borrowOrder);

    // Should match with all three orders across different maturities
    expect(result.matches).toHaveLength(3);

    const maturities = result.matches.map((m) => m.marketId);
    expect(maturities).toContain(marketId1);
    expect(maturities).toContain(marketId2);
    expect(maturities).toContain(marketId3);

    // Total matched should be 1.2M, leaving 200k remaining
    const totalMatched = result.matches.reduce(
      (sum, m) => sum + BigInt(m.matchedAmount),
      0n
    );
    expect(totalMatched.toString()).toBe('1000000');
  });

  it('should only match on overlapping maturities', () => {
    // Lend order for maturity1 and maturity2
    const lendOrder: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId1, marketId2],
      timestamp: Date.now(),
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    engine.submitOrder(lendOrder);

    // Borrow order only for maturity2 and maturity3
    const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId2, marketId3],
      timestamp: Date.now() + 1,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result = engine.submitOrder(borrowOrder);

    // Should only match on maturity2 (the overlap)
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].marketId).toBe(marketId2);
  });

  it('should handle no overlapping maturities', () => {
    // Lend order for maturity1
    const lendOrder: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId1],
      timestamp: Date.now(),
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    engine.submitOrder(lendOrder);

    // Borrow order for maturity2 (no overlap)
    const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId2],
      timestamp: Date.now() + 1,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result = engine.submitOrder(borrowOrder);

    // No matches should occur
    expect(result.matches).toHaveLength(0);
    expect(result.remainingOrder).not.toBeNull();
    expect(result.remainingOrder!.remainingAmount).toBe('500000');
  });

  it('should match with multiple orders at the same maturity', () => {
    // Add multiple lend orders at maturity1
    const lendOrder1: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId1],
      timestamp: Date.now(),
      originalAmount: '300000',
      remainingAmount: '300000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    const lendOrder2: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId1],
      timestamp: Date.now() + 1,
      originalAmount: '400000',
      remainingAmount: '400000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    engine.submitOrder(lendOrder1);
    engine.submitOrder(lendOrder2);

    // Borrow order with multiple maturities including maturity1
    const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
      accountId: accountId2,
      assetId,
      marketIds: [marketId1, marketId2],
      timestamp: Date.now() + 2,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 600,
    });

    const result = engine.submitOrder(borrowOrder);

    // Should match with both lend orders at maturity1
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    const marketId1Matches = result.matches.filter((m) => m.marketId === marketId1);
    expect(marketId1Matches).toHaveLength(2);
  });

  it('should create separate order book entries for each maturity', () => {
    const order: LendLimitOrder = createLendLimitOrder({
      accountId: accountId1,
      assetId,
      marketIds: [marketId1, marketId2, marketId3],
      timestamp: Date.now(),
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    });

    engine.submitOrder(order);

    // Check that order appears in all three market books
    const snapshot1 = engine.getOrderBook(assetId, marketId1, 10);
    const snapshot2 = engine.getOrderBook(assetId, marketId2, 10);
    const snapshot3 = engine.getOrderBook(assetId, marketId3, 10);

    expect(snapshot1.lendOrders).toHaveLength(1);
    expect(snapshot2.lendOrders).toHaveLength(1);
    expect(snapshot3.lendOrders).toHaveLength(1);

    // All should reference the same order
    expect(snapshot1.lendOrders[0].orderId).toBe(order.orderId);
    expect(snapshot2.lendOrders[0].orderId).toBe(order.orderId);
    expect(snapshot3.lendOrders[0].orderId).toBe(order.orderId);
  });
});

