import { MatchingEngine } from '../core/matching-engine';
import type { LendLimitOrder, BorrowLimitOrder } from '../types/orders';
import { OrderSide, OrderType, OrderStatus } from '../types/orders';
import { generateOrderId } from '../utils/helpers';

describe('Price-Time Priority', () => {
  let engine: MatchingEngine;
  const loanToken = '0x1234567890123456789012345678901234567890';
  const collateralToken = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  const maturity = 1704067200;

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  describe('Price Priority', () => {
    it('should match lend orders with best price (lowest rate) first', () => {
      const baseTime = Date.now();

      // Add lend orders at different rates
      const lendOrder1: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '100000',
        remainingAmount: '100000',
        rate: 600, // Higher rate
      };

      const lendOrder2: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 1,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '100000',
        remainingAmount: '100000',
        rate: 400, // Lower rate - should match first
      };

      const lendOrder3: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 2,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '100000',
        remainingAmount: '100000',
        rate: 500, // Middle rate
      };

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);
      engine.submitOrder(lendOrder3);

      // Submit borrow order
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 3,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '250000',
        remainingAmount: '250000',
        rate: 700,
        collateralTokens: [collateralToken],
      };

      const result = engine.submitOrder(borrowOrder);

      // Should match in price order: 400 -> 500 -> 600
      expect(result.matches).toHaveLength(3);
      expect(result.matches[0].rate).toBe(400);
      expect(result.matches[0].lendOrderId).toBe(lendOrder2.orderId);
      expect(result.matches[1].rate).toBe(500);
      expect(result.matches[1].lendOrderId).toBe(lendOrder3.orderId);
      expect(result.matches[2].rate).toBe(600);
      expect(result.matches[2].lendOrderId).toBe(lendOrder1.orderId);
    });

    it('should match borrow orders with best price (highest rate) first', () => {
      const baseTime = Date.now();

      // Add borrow orders at different rates
      const borrowOrder1: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '100000',
        remainingAmount: '100000',
        rate: 500, // Lower rate
        collateralTokens: [collateralToken],
      };

      const borrowOrder2: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '100000',
        remainingAmount: '100000',
        rate: 800, // Higher rate - should match first
        collateralTokens: [collateralToken],
      };

      const borrowOrder3: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 2,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '100000',
        remainingAmount: '100000',
        rate: 600, // Middle rate
        collateralTokens: [collateralToken],
      };

      engine.submitOrder(borrowOrder1);
      engine.submitOrder(borrowOrder2);
      engine.submitOrder(borrowOrder3);

      // Submit lend order
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 3,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '250000',
        remainingAmount: '250000',
        rate: 400,
      };

      const result = engine.submitOrder(lendOrder);

      // Should match in price order: 800 -> 600 -> 500
      expect(result.matches).toHaveLength(3);
      expect(result.matches[0].rate).toBe(800);
      expect(result.matches[0].borrowOrderId).toBe(borrowOrder2.orderId);
      expect(result.matches[1].rate).toBe(600);
      expect(result.matches[1].borrowOrderId).toBe(borrowOrder3.orderId);
      expect(result.matches[2].rate).toBe(500);
      expect(result.matches[2].borrowOrderId).toBe(borrowOrder1.orderId);
    });
  });

  describe('Time Priority', () => {
    it('should match orders with same price in time order (FIFO)', () => {
      const baseTime = Date.now();
      const rate = 500;

      // Add three lend orders at same rate
      const lendOrder1: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '100000',
        remainingAmount: '100000',
        rate,
      };

      const lendOrder2: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 1000, // 1 second later
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '100000',
        remainingAmount: '100000',
        rate,
      };

      const lendOrder3: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 2000, // 2 seconds later
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '100000',
        remainingAmount: '100000',
        rate,
      };

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);
      engine.submitOrder(lendOrder3);

      // Submit borrow order
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 3000,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '250000',
        remainingAmount: '250000',
        rate: 600,
        collateralTokens: [collateralToken],
      };

      const result = engine.submitOrder(borrowOrder);

      // Should match in time order
      expect(result.matches).toHaveLength(3);
      expect(result.matches[0].lendOrderId).toBe(lendOrder1.orderId);
      expect(result.matches[1].lendOrderId).toBe(lendOrder2.orderId);
      expect(result.matches[2].lendOrderId).toBe(lendOrder3.orderId);
    });

    it('should maintain time priority within same price level after partial fills', () => {
      const baseTime = Date.now();
      const rate = 500;

      // Add lend orders
      const lendOrder1: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate,
      };

      const lendOrder2: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 1000,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate,
      };

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // First partial fill
      const borrowOrder1: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 2000,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '600000',
        remainingAmount: '600000',
        rate: 600,
        collateralTokens: [collateralToken],
      };

      const result1 = engine.submitOrder(borrowOrder1);
      expect(result1.matches).toHaveLength(1);
      expect(result1.matches[0].lendOrderId).toBe(lendOrder1.orderId);

      // Second borrow should still match with order1 first (it has earlier timestamp)
      const borrowOrder2: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 3000,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 600,
        collateralTokens: [collateralToken],
      };

      const result2 = engine.submitOrder(borrowOrder2);
      expect(result2.matches).toHaveLength(2);
      expect(result2.matches[0].lendOrderId).toBe(lendOrder1.orderId); // Remaining from order1
      expect(result2.matches[1].lendOrderId).toBe(lendOrder2.orderId); // Then order2
    });
  });

  describe('Combined Price-Time Priority', () => {
    it('should respect price first, then time within same price', () => {
      const baseTime = Date.now();

      // Mix of rates and times
      const orders = [
        { rate: 500, time: baseTime, amount: '100000' },
        { rate: 400, time: baseTime + 2000, amount: '100000' },
        { rate: 500, time: baseTime + 1000, amount: '100000' },
        { rate: 400, time: baseTime + 3000, amount: '100000' },
        { rate: 600, time: baseTime + 500, amount: '100000' },
      ];

      const orderIds: string[] = [];

      for (const { rate, time, amount } of orders) {
        const order: LendLimitOrder = {
          orderId: generateOrderId(),
          walletAddress: walletAddress1,
          loanToken,
          maturities: [maturity],
          timestamp: time,
          side: OrderSide.Lend,
          type: OrderType.Limit,
          status: OrderStatus.Open,
          originalAmount: amount,
          remainingAmount: amount,
          rate,
        };
        orderIds.push(order.orderId);
        engine.submitOrder(order);
      }

      // Submit borrow order to match all
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: baseTime + 4000,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '500000',
        remainingAmount: '500000',
        rate: 700,
        collateralTokens: [collateralToken],
      };

      const result = engine.submitOrder(borrowOrder);

      // Expected order: 400 (time: 2000), 400 (time: 3000), 500 (time: 0), 500 (time: 1000), 600 (time: 500)
      expect(result.matches).toHaveLength(5);
      expect(result.matches[0].rate).toBe(400);
      expect(result.matches[0].lendOrderId).toBe(orderIds[1]); // rate 400, time 2000
      expect(result.matches[1].rate).toBe(400);
      expect(result.matches[1].lendOrderId).toBe(orderIds[3]); // rate 400, time 3000
      expect(result.matches[2].rate).toBe(500);
      expect(result.matches[2].lendOrderId).toBe(orderIds[0]); // rate 500, time 0
      expect(result.matches[3].rate).toBe(500);
      expect(result.matches[3].lendOrderId).toBe(orderIds[2]); // rate 500, time 1000
      expect(result.matches[4].rate).toBe(600);
      expect(result.matches[4].lendOrderId).toBe(orderIds[4]); // rate 600, time 500
    });
  });
});

