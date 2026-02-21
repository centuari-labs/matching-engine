import { MatchingEngine } from '../core/matching-engine';
import type { LendLimitOrder, BorrowLimitOrder, LendMarketOrder, BorrowMarketOrder } from '../types/orders';
import { OrderSide, OrderType, OrderStatus } from '../types/orders';
import { generateOrderId } from '../utils/helpers';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  createBorrowMarketOrder,
  marketsFromMaturities,
  DEFAULT_LOAN_TOKEN,
  DEFAULT_MATURITY,
} from './factories/order-factory';

describe('MatchingEngine', () => {
  let engine: MatchingEngine;
  const loanToken = DEFAULT_LOAN_TOKEN;
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  const maturity = DEFAULT_MATURITY;

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  describe('Lend Limit Order Matching', () => {
    it('should match lend limit order with borrow limit order at acceptable rate', () => {
      // Create lend order at 500 bps (5%)
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        rate: 500,
      });

      // Create borrow order at 600 bps (6%) - willing to pay more
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        rate: 600,
      });

      // Submit lend order first (becomes maker)
      const lendResult = engine.submitOrder(lendOrder);
      expect(lendResult.matches).toHaveLength(0);
      expect(lendResult.remainingOrder).not.toBeNull();

      // Submit borrow order (becomes taker)
      const borrowResult = engine.submitOrder(borrowOrder);
      expect(borrowResult.matches).toHaveLength(1);
      expect(borrowResult.matches[0].matchedAmount).toBe('1000000');
      expect(borrowResult.matches[0].rate).toBe(500); // Maker's rate
      expect(borrowResult.remainingOrder).toBeNull(); // Fully filled
    });

    it('should not match if borrow rate is lower than lend rate', () => {
      // Lender wants 800 bps
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        rate: 800,
      });

      // Borrower only willing to pay 600 bps
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        rate: 600,
      });

      engine.submitOrder(lendOrder);
      const borrowResult = engine.submitOrder(borrowOrder);

      expect(borrowResult.matches).toHaveLength(0);
      expect(borrowResult.remainingOrder).not.toBeNull();
    });

    it('should match at exact same rate', () => {
      const rate = 500;

      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        rate,
      });

      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        rate,
      });

      engine.submitOrder(lendOrder);
      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].rate).toBe(rate);
    });
  });

  describe('Borrow Limit Order Matching', () => {
    it('should match borrow limit order with lend limit order', () => {
      // Borrower willing to pay 700 bps
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        rate: 700,
      });

      // Lender wants 500 bps
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        rate: 500,
      });

      // Submit borrow first (becomes maker)
      engine.submitOrder(borrowOrder);

      // Submit lend (becomes taker)
      const result = engine.submitOrder(lendOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].rate).toBe(700); // Taker gets maker's rate
    });
  });

  describe('Market Order Matching', () => {
    it('should match lend market order with best borrow limit orders', () => {
      // Add multiple borrow limit orders at different rates
      const borrowOrder1: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '500000',
        remainingAmount: '500000',
        rate: 600,
      });

      const borrowOrder2: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        rate: 800, // Higher rate - better for lender
      });

      engine.submitOrder(borrowOrder1);
      engine.submitOrder(borrowOrder2);

      // Submit lend market order
      const lendMarket: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        originalAmount: '1000000',
        remainingAmount: '1000000',
      });

      const result = engine.submitOrder(lendMarket);

      // Should match with both orders, highest rate first
      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].rate).toBe(800); // Best rate first
      expect(result.matches[1].rate).toBe(600);
      expect(result.remainingOrder).toBeNull(); // Fully filled
    });

    it('should match borrow market order with best lend limit orders', () => {
      // Add multiple lend limit orders at different rates
      const lendOrder1: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '500000',
        remainingAmount: '500000',
        rate: 400, // Lower rate - better for borrower
      });

      const lendOrder2: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        rate: 600,
      });

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // Submit borrow market order
      const borrowMarket: BorrowMarketOrder = createBorrowMarketOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        originalAmount: '1000000',
        remainingAmount: '1000000',
      });

      const result = engine.submitOrder(borrowMarket);

      // Should match with both orders, lowest rate first
      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].rate).toBe(400); // Best rate first
      expect(result.matches[1].rate).toBe(600);
    });
  });

  describe('Order Cancellation', () => {
    it('should cancel an open order', () => {
      const order: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        rate: 500,
      });

      engine.submitOrder(order);
      const cancelled = engine.cancelOrder(order.orderId, order.walletAddress);

      expect(cancelled).toBe(true);
      expect(engine.getOrderStatus(order.orderId)).toBeNull();
    });

    it('should return false when cancelling non-existent order', () => {
      const cancelled = engine.cancelOrder('non-existent-id', walletAddress1);
      expect(cancelled).toBe(false);
    });

    it('should return false when wallet address does not match', () => {
      const order: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        rate: 500,
      });

      engine.submitOrder(order);
      // Try to cancel with wrong wallet address
      const cancelled = engine.cancelOrder(order.orderId, walletAddress2);
      expect(cancelled).toBe(false);
      // Order should still exist
      expect(engine.getOrderStatus(order.orderId)).toBe(OrderStatus.Open);
    });
  });

  describe('Order Book Snapshot', () => {
    it('should return order book snapshot', () => {
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        rate: 500,
      });

      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '2000000',
        remainingAmount: '2000000',
        rate: 300,
      });

      engine.submitOrder(lendOrder);
      engine.submitOrder(borrowOrder);

      const snapshot = engine.getOrderBook(loanToken, maturity, 10);

      expect(snapshot.lendOrders).toHaveLength(1);
      expect(snapshot.borrowOrders).toHaveLength(1);
      expect(snapshot.lendOrders[0].rate).toBe(500);
      expect(snapshot.borrowOrders[0].rate).toBe(300);
    });
  });

  describe('Market Order Edge Cases', () => {
    it('should reject lend market order with no liquidity', () => {
      const lendMarket: LendMarketOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      const result = engine.submitOrder(lendMarket);

      // Should have no matches and not be added to book
      expect(result.matches).toHaveLength(0);
      expect(result.remainingOrder).toBeNull();
      expect(engine.getOrderStatus(lendMarket.orderId)).toBeNull();
    });

    it('should reject borrow market order with no liquidity', () => {
      const borrowMarket: BorrowMarketOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Borrow,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      const result = engine.submitOrder(borrowMarket);

      // Should have no matches and not be added to book
      expect(result.matches).toHaveLength(0);
      expect(result.remainingOrder).toBeNull();
      expect(engine.getOrderStatus(borrowMarket.orderId)).toBeNull();
    });

    it('should reject remaining amount when lend market order partially fills', () => {
      // Add one borrow order with less amount
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(borrowOrder);

      // Submit larger market order
      const lendMarket: LendMarketOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Lend,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      const result = engine.submitOrder(lendMarket);

      // Should match partially but remaining should not be in book
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].matchedAmount).toBe('500000');
      expect(result.remainingOrder).toBeNull(); // Market orders can't rest
      expect(engine.getOrderStatus(lendMarket.orderId)).toBeNull();
    });

    it('should reject remaining amount when borrow market order partially fills', () => {
      // Add one lend order with less amount
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 400,
      };

      engine.submitOrder(lendOrder);

      // Submit larger market order
      const borrowMarket: BorrowMarketOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      const result = engine.submitOrder(borrowMarket);

      // Should match partially but remaining should not be in book
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].matchedAmount).toBe('500000');
      expect(result.remainingOrder).toBeNull(); // Market orders can't rest
      expect(engine.getOrderStatus(borrowMarket.orderId)).toBeNull();
    });
  });

  describe('Partial Fill Scenarios', () => {
    it('should keep limit order in book after partial fill', () => {
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // Partial fill
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].matchedAmount).toBe('300000');

      // Lend order should still be in book with PartiallyFilled status
      const status = engine.getOrderStatus(lendOrder.orderId);
      expect(status).toBe(OrderStatus.PartiallyFilled);

      const snapshot = engine.getOrderBook(loanToken, maturity, 10);
      expect(snapshot.lendOrders).toHaveLength(1);
      expect(snapshot.lendOrders[0].amount).toBe('700000'); // Remaining amount
    });

    it('should handle multiple partial fills on same order', () => {
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // First partial fill
      const borrowOrder1: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      const result1 = engine.submitOrder(borrowOrder1);
      expect(result1.matches).toHaveLength(1);
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.PartiallyFilled);

      // Second partial fill
      const borrowOrder2: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '400000',
        remainingAmount: '400000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      const result2 = engine.submitOrder(borrowOrder2);
      expect(result2.matches).toHaveLength(1);
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.PartiallyFilled);

      // Third partial fill - completes the order
      const borrowOrder3: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 3,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 600
      };

      const result3 = engine.submitOrder(borrowOrder3);
      expect(result3.matches).toHaveLength(1);
      
      // Order should be removed from book when fully filled
      expect(engine.getOrderStatus(lendOrder.orderId)).toBeNull();
      const snapshot = engine.getOrderBook(loanToken, maturity, 10);
      expect(snapshot.lendOrders).toHaveLength(0);
    });

    it('should transition order status correctly (Open → PartiallyFilled → Filled)', () => {
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.Open);

      // Partial fill
      const borrowOrder1: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(borrowOrder1);
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.PartiallyFilled);

      // Complete fill
      const borrowOrder2: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600
      };

      engine.submitOrder(borrowOrder2);
      // Order should be removed from book when fully filled
      expect(engine.getOrderStatus(lendOrder.orderId)).toBeNull();
    });
  });

  describe('Cancellation Edge Cases', () => {
    it('should allow cancelling partially filled order', () => {
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // Partial fill
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(borrowOrder);
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.PartiallyFilled);

      // Cancel remaining
      const cancelled = engine.cancelOrder(lendOrder.orderId, lendOrder.walletAddress);
      expect(cancelled).toBe(true);
      expect(engine.getOrderStatus(lendOrder.orderId)).toBeNull();
    });

    it('should fail to cancel fully filled order', () => {
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // Fully fill
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(borrowOrder);
      // Order should be removed from book when fully filled
      expect(engine.getOrderStatus(lendOrder.orderId)).toBeNull();

      // Try to cancel - should fail (order doesn't exist)
      const cancelled = engine.cancelOrder(lendOrder.orderId, lendOrder.walletAddress);
      expect(cancelled).toBe(false);
    });

    it('should fail to cancel order twice', () => {
      const order: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // First cancellation should succeed
      const cancelled1 = engine.cancelOrder(order.orderId, order.walletAddress);
      expect(cancelled1).toBe(true);

      // Second cancellation should fail
      const cancelled2 = engine.cancelOrder(order.orderId, order.walletAddress);
      expect(cancelled2).toBe(false);
    });
  });

  describe('Order Book State Management', () => {
    it('should return empty arrays for empty order book', () => {
      const snapshot = engine.getOrderBook(loanToken, maturity, 10);

      expect(snapshot.lendOrders).toHaveLength(0);
      expect(snapshot.borrowOrders).toHaveLength(0);
      expect(snapshot.loanToken).toBe(loanToken);
      expect(snapshot.maturity).toBe(maturity);
    });

    it('should reflect correct remaining amounts after partial fill', () => {
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // Partial fill
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(borrowOrder);

      const snapshot = engine.getOrderBook(loanToken, maturity, 10);
      expect(snapshot.lendOrders).toHaveLength(1);
      expect(snapshot.lendOrders[0].amount).toBe('700000'); // 1000000 - 300000
    });

    it('should remove order from book after full fill', () => {
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // Fully fill
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(borrowOrder);

      const snapshot = engine.getOrderBook(loanToken, maturity, 10);
      expect(snapshot.lendOrders).toHaveLength(0);
    });

    it('should respect depth parameter in order book snapshot', () => {
      // Add multiple orders
      for (let i = 0; i < 5; i++) {
        const lendOrder: LendLimitOrder = {
          orderId: generateOrderId(),
          walletAddress: walletAddress1,
          loanToken,
          markets: marketsFromMaturities([maturity]),
          timestamp: Date.now() + i,
          side: OrderSide.Lend,
          type: OrderType.Limit,
          status: OrderStatus.Open,
          originalAmount: '1000000',
          remainingAmount: '1000000',
          settlementFeeAmount: '10000',
          rate: 500 + i * 10,
        };
        engine.submitOrder(lendOrder);
      }

      const snapshot = engine.getOrderBook(loanToken, maturity, 3);
      expect(snapshot.lendOrders).toHaveLength(3);
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle orders with same timestamp deterministically', () => {
      const baseTime = Date.now();

      const lendOrder1: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: baseTime,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      };

      const lendOrder2: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: baseTime, // Same timestamp
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500, // Same rate
      };

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // Both should be in book
      const snapshot = engine.getOrderBook(loanToken, maturity, 10);
      expect(snapshot.lendOrders).toHaveLength(2);
    });

    it('should handle exact amount matching', () => {
      const amount = '1234567890';

      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: amount,
        remainingAmount: amount,
        settlementFeeAmount: '10000',
        rate: 500,
      };

      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: amount,
        remainingAmount: amount,
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(lendOrder);
      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].matchedAmount).toBe(amount);
      expect(result.remainingOrder).toBeNull(); // Both fully filled
      // Orders should be removed from book when fully filled
      expect(engine.getOrderStatus(lendOrder.orderId)).toBeNull();
      expect(engine.getOrderStatus(borrowOrder.orderId)).toBeNull();
    });

    it('should handle very large amounts', () => {
      const largeAmount = '999999999999999999999999';

      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: largeAmount,
        remainingAmount: largeAmount,
        settlementFeeAmount: '10000',
        rate: 500,
      };

      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000',
        remainingAmount: '1000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(lendOrder);
      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].matchedAmount).toBe('1000');

      // Lend order should still exist with large remaining amount
      const snapshot = engine.getOrderBook(loanToken, maturity, 10);
      expect(snapshot.lendOrders).toHaveLength(1);
      expect(BigInt(snapshot.lendOrders[0].amount)).toBe(BigInt(largeAmount) - BigInt('1000'));
    });

    it('should match one order with multiple counterparties', () => {
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // Multiple small borrow orders
      const borrowOrder1: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '200000',
        remainingAmount: '200000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      const borrowOrder2: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      const borrowOrder3: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 3,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(borrowOrder1);
      engine.submitOrder(borrowOrder2);
      const result3 = engine.submitOrder(borrowOrder3);

      // All three should match
      expect(result3.matches).toHaveLength(1); // Only the last one creates a match record
      
      // Check total matches for lend order
      const matches = engine.getMatches(lendOrder.orderId);
      expect(matches.length).toBeGreaterThanOrEqual(3);
      
      const totalMatched = matches.reduce((sum, m) => sum + BigInt(m.matchedAmount), 0n);
      expect(totalMatched.toString()).toBe('1000000');
    });

    it('should exhaust all available liquidity', () => {
      // Add multiple small lend orders
      const lendOrder1: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '200000',
        remainingAmount: '200000',
        settlementFeeAmount: '10000',
        rate: 400,
      };

      const lendOrder2: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 500,
      };

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // Large borrow order that exhausts all liquidity
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      const result = engine.submitOrder(borrowOrder);

      // Should match with both lend orders
      expect(result.matches.length).toBeGreaterThanOrEqual(2);
      
      // All lend orders should be fully filled and removed from book
      expect(engine.getOrderStatus(lendOrder1.orderId)).toBeNull();
      expect(engine.getOrderStatus(lendOrder2.orderId)).toBeNull();
      
      // Borrow order should be partially filled
      expect(result.remainingOrder).not.toBeNull();
      expect(result.remainingOrder!.remainingAmount).toBe('500000'); // 1000000 - 500000
    });
  });

  describe('Self-Matching Prevention', () => {
    it('should not match lend limit order with borrow order from the same wallet', () => {
      const sameWallet = '0x3333333333333333333333333333333333333333';

      // Create lend order
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      };

      // Create borrow order from the same wallet with acceptable rate
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600 // Higher than lend rate - would normally match
      };

      // Submit lend order first
      engine.submitOrder(lendOrder);

      // Submit borrow order from same wallet
      const result = engine.submitOrder(borrowOrder);

      // Should NOT match due to same wallet
      expect(result.matches).toHaveLength(0);

      // Both orders should remain in the book
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.Open);
      expect(engine.getOrderStatus(borrowOrder.orderId)).toBe(OrderStatus.Open);
    });

    it('should not match borrow limit order with lend order from the same wallet', () => {
      const sameWallet = '0x3333333333333333333333333333333333333333';

      // Create borrow order first
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      // Create lend order from the same wallet
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500, // Lower than borrow rate - would normally match
      };

      // Submit borrow order first
      engine.submitOrder(borrowOrder);

      // Submit lend order from same wallet
      const result = engine.submitOrder(lendOrder);

      // Should NOT match due to same wallet
      expect(result.matches).toHaveLength(0);

      // Both orders should remain in the book
      expect(engine.getOrderStatus(borrowOrder.orderId)).toBe(OrderStatus.Open);
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.Open);
    });

    it('should not match lend market order with borrow order from the same wallet', () => {
      const sameWallet = '0x3333333333333333333333333333333333333333';

      // Create borrow limit order
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      engine.submitOrder(borrowOrder);

      // Create lend market order from the same wallet
      const lendMarket: LendMarketOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Lend,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      const result = engine.submitOrder(lendMarket);

      // Should NOT match due to same wallet
      expect(result.matches).toHaveLength(0);

      // Borrow order should still be in book
      expect(engine.getOrderStatus(borrowOrder.orderId)).toBe(OrderStatus.Open);

      // Market order should be rejected (not added to book)
      expect(engine.getOrderStatus(lendMarket.orderId)).toBeNull();
    });

    it('should not match borrow market order with lend order from the same wallet', () => {
      const sameWallet = '0x3333333333333333333333333333333333333333';

      // Create lend limit order
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // Create borrow market order from the same wallet
      const borrowMarket: BorrowMarketOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      const result = engine.submitOrder(borrowMarket);

      // Should NOT match due to same wallet
      expect(result.matches).toHaveLength(0);

      // Lend order should still be in book
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.Open);

      // Market order should be rejected (not added to book)
      expect(engine.getOrderStatus(borrowMarket.orderId)).toBeNull();
    });

    it('should match with other wallets while skipping same wallet orders', () => {
      const sameWallet = '0x3333333333333333333333333333333333333333';
      const differentWallet = '0x4444444444444444444444444444444444444444';

      // Create lend order from sameWallet
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // Create borrow order from sameWallet (should NOT match)
      const borrowOrderSameWallet: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: sameWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      };

      const result1 = engine.submitOrder(borrowOrderSameWallet);
      expect(result1.matches).toHaveLength(0);

      // Create borrow order from differentWallet (should match)
      const borrowOrderDiffWallet: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: differentWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600
      };

      const result2 = engine.submitOrder(borrowOrderDiffWallet);

      // Should match with lend order since it's from a different wallet
      expect(result2.matches).toHaveLength(1);
      expect(result2.matches[0].matchedAmount).toBe('500000');

      // Lend order should be partially filled
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.PartiallyFilled);

      // Same wallet borrow order should still be in book
      expect(engine.getOrderStatus(borrowOrderSameWallet.orderId)).toBe(OrderStatus.Open);
    });

    it('should handle case-insensitive wallet address comparison', () => {
      const lowerCaseWallet = '0xabcdef1234567890abcdef1234567890abcdef12';
      const mixedCaseWallet = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';

      // Create lend order with lowercase wallet
      const lendOrder: LendLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: lowerCaseWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
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

      // Create borrow order with mixed case wallet (same address)
      const borrowOrder: BorrowLimitOrder = {
        orderId: generateOrderId(),
        walletAddress: mixedCaseWallet,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600
      };

      const result = engine.submitOrder(borrowOrder);

      // Should NOT match - same wallet despite different case
      expect(result.matches).toHaveLength(0);

      // Both orders should remain in the book
      expect(engine.getOrderStatus(lendOrder.orderId)).toBe(OrderStatus.Open);
      expect(engine.getOrderStatus(borrowOrder.orderId)).toBe(OrderStatus.Open);
    });
  });
});

