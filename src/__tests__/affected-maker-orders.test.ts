import { MatchingEngine } from '../core/matching-engine';
import type {
  LendLimitOrder,
  BorrowLimitOrder,
  LendMarketOrder,
  BorrowMarketOrder,
} from '../types/orders';
import { OrderStatus } from '../types/orders';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  createBorrowMarketOrder,
  marketsFromMaturities,
} from './factories/order-factory';

describe('Affected Maker Orders', () => {
  let engine: MatchingEngine;
  const loanToken = '0x1234567890123456789012345678901234567890';
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  const maturity = 1704067200;

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  describe('Lend order as taker matching borrow makers', () => {
    it('should track affected borrow order when fully filled', () => {
      // Create borrow order (maker)
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder);

      // Create lend order (taker) that fully fills the borrow order
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      const result = engine.submitOrder(lendOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.affectedMakerOrders).toHaveLength(1);
      expect(result.affectedMakerOrders[0].orderId).toBe(borrowOrder.orderId);
      expect(result.affectedMakerOrders[0].status).toBe(OrderStatus.Filled);
      expect(result.affectedMakerOrders[0].remainingAmount).toBe('0');
    });

    it('should track affected borrow order when partially filled', () => {
      // Create borrow order (maker) with larger amount
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder);

      // Create smaller lend order (taker) that partially fills the borrow order
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      const result = engine.submitOrder(lendOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.affectedMakerOrders).toHaveLength(1);
      expect(result.affectedMakerOrders[0].orderId).toBe(borrowOrder.orderId);
      expect(result.affectedMakerOrders[0].status).toBe(OrderStatus.PartiallyFilled);
      expect(result.affectedMakerOrders[0].remainingAmount).toBe('700000');
    });

    it('should track multiple affected borrow orders', () => {
      // Create multiple borrow orders (makers)
      const borrowOrder1: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 700,
      });

      const borrowOrder2: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '400000',
        remainingAmount: '400000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder1);
      engine.submitOrder(borrowOrder2);

      // Create lend order (taker) that matches both
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        originalAmount: '700000',
        remainingAmount: '700000',
        rate: 500,
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(lendOrder);

      expect(result.matches).toHaveLength(2);
      expect(result.affectedMakerOrders).toHaveLength(2);

      // Both should be fully filled
      expect(result.affectedMakerOrders[0].orderId).toBe(borrowOrder1.orderId);
      expect(result.affectedMakerOrders[0].status).toBe(OrderStatus.Filled);
      expect(result.affectedMakerOrders[0].remainingAmount).toBe('0');

      expect(result.affectedMakerOrders[1].orderId).toBe(borrowOrder2.orderId);
      expect(result.affectedMakerOrders[1].status).toBe(OrderStatus.Filled);
      expect(result.affectedMakerOrders[1].remainingAmount).toBe('0');
    });
  });

  describe('Borrow order as taker matching lend makers', () => {
    it('should track affected lend order when fully filled', () => {
      // Create lend order (maker)
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder);

      // Create borrow order (taker) that fully fills the lend order
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.affectedMakerOrders).toHaveLength(1);
      expect(result.affectedMakerOrders[0].orderId).toBe(lendOrder.orderId);
      expect(result.affectedMakerOrders[0].status).toBe(OrderStatus.Filled);
      expect(result.affectedMakerOrders[0].remainingAmount).toBe('0');
    });

    it('should track affected lend order when partially filled', () => {
      // Create lend order (maker) with larger amount
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder);

      // Create smaller borrow order (taker) that partially fills the lend order
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '400000',
        remainingAmount: '400000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.affectedMakerOrders).toHaveLength(1);
      expect(result.affectedMakerOrders[0].orderId).toBe(lendOrder.orderId);
      expect(result.affectedMakerOrders[0].status).toBe(OrderStatus.PartiallyFilled);
      expect(result.affectedMakerOrders[0].remainingAmount).toBe('600000');
    });

    it('should track multiple affected lend orders', () => {
      // Create multiple lend orders (makers)
      const lendOrder1: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '200000',
        remainingAmount: '200000',
        rate: 400,
        settlementFeeAmount: '10000',
      });

      const lendOrder2: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // Create borrow order (taker) that matches both
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(2);
      expect(result.affectedMakerOrders).toHaveLength(2);

      // Both should be fully filled
      expect(result.affectedMakerOrders[0].orderId).toBe(lendOrder1.orderId);
      expect(result.affectedMakerOrders[0].status).toBe(OrderStatus.Filled);
      expect(result.affectedMakerOrders[0].remainingAmount).toBe('0');

      expect(result.affectedMakerOrders[1].orderId).toBe(lendOrder2.orderId);
      expect(result.affectedMakerOrders[1].status).toBe(OrderStatus.Filled);
      expect(result.affectedMakerOrders[1].remainingAmount).toBe('0');
    });
  });

  describe('Market orders', () => {
    it('should track affected orders when lend market order matches multiple borrow orders', () => {
      // Create multiple borrow orders
      const borrowOrder1: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 800,
      });

      const borrowOrder2: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
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
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(lendMarket);

      expect(result.matches).toHaveLength(2);
      expect(result.affectedMakerOrders).toHaveLength(2);

      // Both borrow orders should be fully filled
      expect(result.affectedMakerOrders[0].status).toBe(OrderStatus.Filled);
      expect(result.affectedMakerOrders[1].status).toBe(OrderStatus.Filled);
    });

    it('should track affected orders when borrow market order matches multiple lend orders', () => {
      // Create multiple lend orders
      const lendOrder1: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '400000',
        remainingAmount: '400000',
        settlementFeeAmount: '10000',
        rate: 400,
      });

      const lendOrder2: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '600000',
        remainingAmount: '600000',
        rate: 500,
        settlementFeeAmount: '10000',
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
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(borrowMarket);

      expect(result.matches).toHaveLength(2);
      expect(result.affectedMakerOrders).toHaveLength(2);

      // Both lend orders should be fully filled
      expect(result.affectedMakerOrders[0].status).toBe(OrderStatus.Filled);
      expect(result.affectedMakerOrders[1].status).toBe(OrderStatus.Filled);
    });
  });

  describe('No matches', () => {
    it('should return empty affectedMakerOrders when no matches occur', () => {
      // Create lend order
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 800, // High rate
      });

      // Create borrow order with rate too low to match
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500, // Too low to match
      });

      engine.submitOrder(lendOrder);
      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(0);
      expect(result.affectedMakerOrders).toHaveLength(0);
    });

    it('should return empty affectedMakerOrders for first order in empty book', () => {
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      const result = engine.submitOrder(lendOrder);

      expect(result.matches).toHaveLength(0);
      expect(result.affectedMakerOrders).toHaveLength(0);
    });

    it('should return empty affectedMakerOrders for market order with no liquidity', () => {
      const lendMarket: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(lendMarket);

      expect(result.matches).toHaveLength(0);
      expect(result.affectedMakerOrders).toHaveLength(0);
    });
  });

  describe('Mixed fill scenarios', () => {
    it('should correctly track partially and fully filled maker orders', () => {
      // Create two lend orders of different sizes
      const lendOrder1: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 400,
      });

      const lendOrder2: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // Create borrow order that fully fills first and partially fills second
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(2);
      expect(result.affectedMakerOrders).toHaveLength(2);

      // First order should be fully filled
      expect(result.affectedMakerOrders[0].orderId).toBe(lendOrder1.orderId);
      expect(result.affectedMakerOrders[0].status).toBe(OrderStatus.Filled);
      expect(result.affectedMakerOrders[0].remainingAmount).toBe('0');

      // Second order should be partially filled
      expect(result.affectedMakerOrders[1].orderId).toBe(lendOrder2.orderId);
      expect(result.affectedMakerOrders[1].status).toBe(OrderStatus.PartiallyFilled);
      expect(result.affectedMakerOrders[1].remainingAmount).toBe('300000');
    });
  });
});
