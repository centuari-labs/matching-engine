import { MatchingEngine } from '../core/matching-engine';
import type { LendLimitOrder, BorrowLimitOrder } from '../types/orders';
import { OrderSide, OrderType, OrderStatus } from '../types/orders';
import { generateOrderId } from '../utils/helpers';

describe('Multiple Maturities Matching', () => {
  let engine: MatchingEngine;
  const loanToken = '0x1234567890123456789012345678901234567890';
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  const maturity1 = 1704067200; // Jan 1, 2024
  const maturity2 = 1735689600; // Jan 1, 2025
  const maturity3 = 1767225600; // Jan 1, 2026

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  it('should match orders with single maturity across multiple order maturities', () => {
    // Lend order with single maturity
    const lendOrder: LendLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress1,
      loanToken,
      maturities: [maturity1],
      timestamp: Date.now(),
      side: OrderSide.Lend,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    };

    engine.submitOrder(lendOrder);

    // Borrow order with multiple maturities including maturity1
    const borrowOrder: BorrowLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress2,
      loanToken,
      maturities: [maturity1, maturity2, maturity3],
      timestamp: Date.now() + 1,
      side: OrderSide.Borrow,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '10000',
      rate: 600
    };

    const result = engine.submitOrder(borrowOrder);

    // Should match on maturity1
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].maturity).toBe(maturity1);
    expect(result.matches[0].matchedAmount).toBe('500000');
    expect(result.remainingOrder).toBeNull();
  });

  it('should match across multiple maturities when sufficient liquidity exists', () => {
    // Add lend orders at different maturities
    const lendOrder1: LendLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress1,
      loanToken,
      maturities: [maturity1],
      timestamp: Date.now(),
      side: OrderSide.Lend,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '300000',
      remainingAmount: '300000',
      settlementFeeAmount: '10000',
      rate: 500,
    };

    const lendOrder2: LendLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress1,
      loanToken,
      maturities: [maturity2],
      timestamp: Date.now() + 1,
      side: OrderSide.Lend,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '400000',
      remainingAmount: '400000',
      settlementFeeAmount: '10000',
      rate: 500,
    };

    const lendOrder3: LendLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress1,
      loanToken,
      maturities: [maturity3],
      timestamp: Date.now() + 2,
      side: OrderSide.Lend,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '10000',
      rate: 500,
    };

    engine.submitOrder(lendOrder1);
    engine.submitOrder(lendOrder2);
    engine.submitOrder(lendOrder3);

    // Borrow order matching all three maturities
    const borrowOrder: BorrowLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress2,
      loanToken,
      maturities: [maturity1, maturity2, maturity3],
      timestamp: Date.now() + 3,
      side: OrderSide.Borrow,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 600
    };

    const result = engine.submitOrder(borrowOrder);

    // Should match with all three orders across different maturities
    expect(result.matches).toHaveLength(3);

    const maturities = result.matches.map((m) => m.maturity);
    expect(maturities).toContain(maturity1);
    expect(maturities).toContain(maturity2);
    expect(maturities).toContain(maturity3);

    // Total matched should be 1.2M, leaving 200k remaining
    const totalMatched = result.matches.reduce(
      (sum, m) => sum + BigInt(m.matchedAmount),
      0n
    );
    expect(totalMatched.toString()).toBe('1000000');
  });

  it('should only match on overlapping maturities', () => {
    // Lend order for maturity1 and maturity2
    const lendOrder: LendLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress1,
      loanToken,
      maturities: [maturity1, maturity2],
      timestamp: Date.now(),
      side: OrderSide.Lend,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    };

    engine.submitOrder(lendOrder);

    // Borrow order only for maturity2 and maturity3
    const borrowOrder: BorrowLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress2,
      loanToken,
      maturities: [maturity2, maturity3],
      timestamp: Date.now() + 1,
      side: OrderSide.Borrow,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '10000',
      rate: 600
    };

    const result = engine.submitOrder(borrowOrder);

    // Should only match on maturity2 (the overlap)
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].maturity).toBe(maturity2);
  });

  it('should handle no overlapping maturities', () => {
    // Lend order for maturity1
    const lendOrder: LendLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress1,
      loanToken,
      maturities: [maturity1],
      timestamp: Date.now(),
      side: OrderSide.Lend,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    };

    engine.submitOrder(lendOrder);

    // Borrow order for maturity2 (no overlap)
    const borrowOrder: BorrowLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress2,
      loanToken,
      maturities: [maturity2],
      timestamp: Date.now() + 1,
      side: OrderSide.Borrow,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '10000',
      rate: 600
    };

    const result = engine.submitOrder(borrowOrder);

    // No matches should occur
    expect(result.matches).toHaveLength(0);
    expect(result.remainingOrder).not.toBeNull();
    expect(result.remainingOrder!.remainingAmount).toBe('500000');
  });

  it('should match with multiple orders at the same maturity', () => {
    // Add multiple lend orders at maturity1
    const lendOrder1: LendLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress1,
      loanToken,
      maturities: [maturity1],
      timestamp: Date.now(),
      side: OrderSide.Lend,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '300000',
      remainingAmount: '300000',
      settlementFeeAmount: '10000',
      rate: 500,
    };

    const lendOrder2: LendLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress1,
      loanToken,
      maturities: [maturity1],
      timestamp: Date.now() + 1,
      side: OrderSide.Lend,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '400000',
      remainingAmount: '400000',
      settlementFeeAmount: '10000',
      rate: 500,
    };

    engine.submitOrder(lendOrder1);
    engine.submitOrder(lendOrder2);

    // Borrow order with multiple maturities including maturity1
    const borrowOrder: BorrowLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress2,
      loanToken,
      maturities: [maturity1, maturity2],
      timestamp: Date.now() + 2,
      side: OrderSide.Borrow,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 600
    };

    const result = engine.submitOrder(borrowOrder);

    // Should match with both lend orders at maturity1
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    const maturity1Matches = result.matches.filter((m) => m.maturity === maturity1);
    expect(maturity1Matches).toHaveLength(2);
  });

  it('should create separate order book entries for each maturity', () => {
    const order: LendLimitOrder = {
      orderId: generateOrderId(),
      walletAddress: walletAddress1,
      loanToken,
      maturities: [maturity1, maturity2, maturity3],
      timestamp: Date.now(),
      side: OrderSide.Lend,
      type: OrderType.Limit,
      status: OrderStatus.Open,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    };

    engine.submitOrder(order);

    // Check that order appears in all three maturity books
    const snapshot1 = engine.getOrderBook(loanToken, maturity1, 10);
    const snapshot2 = engine.getOrderBook(loanToken, maturity2, 10);
    const snapshot3 = engine.getOrderBook(loanToken, maturity3, 10);

    expect(snapshot1.lendOrders).toHaveLength(1);
    expect(snapshot2.lendOrders).toHaveLength(1);
    expect(snapshot3.lendOrders).toHaveLength(1);

    // All should reference the same order
    expect(snapshot1.lendOrders[0].orderId).toBe(order.orderId);
    expect(snapshot2.lendOrders[0].orderId).toBe(order.orderId);
    expect(snapshot3.lendOrders[0].orderId).toBe(order.orderId);
  });
});

