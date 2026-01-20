import { MatchingEngine } from '../core/matching-engine';
import type {
  LendLimitOrder,
  BorrowLimitOrder,
  LendMarketOrder,
  BorrowMarketOrder,
} from '../types/orders';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  createBorrowMarketOrder,
} from './factories/order-factory';

/**
 * Tests for the borrowerIsTaker field in matches
 *
 * The borrowerIsTaker field indicates which order is the taker:
 * - true: The borrower is the taker (incoming borrow order matched against existing lend order)
 * - false: The borrower is the maker (incoming lend order matched against existing borrow order)
 *
 * Taker = incoming order that triggers the match (takes liquidity)
 * Maker = order already in the order book (provides liquidity)
 */
describe('BorrowerIsTaker Field', () => {
  let engine: MatchingEngine;
  const loanToken = '0x1234567890123456789012345678901234567890';
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  const maturity = 1704067200;

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  describe('Lend Market Order (borrowerIsTaker = false)', () => {
    it('should set borrowerIsTaker to false when lend market order matches borrow limit order', () => {
      // Borrow limit order is placed first (becomes maker)
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder);

      // Lend market order comes in (becomes taker)
      const lendMarket: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(lendMarket);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].borrowerIsTaker).toBe(false);
      expect(result.matches[0].lendOrderId).toBe(lendMarket.orderId);
      expect(result.matches[0].borrowOrderId).toBe(borrowOrder.orderId);
    });

    it('should set borrowerIsTaker to false for all matches when lend market order matches multiple borrow orders', () => {
      // Add multiple borrow orders (all become makers)
      const borrowOrder1: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 800,
      });

      const borrowOrder2: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder1);
      engine.submitOrder(borrowOrder2);

      // Lend market order matches both (taker)
      const lendMarket: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 2,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(lendMarket);

      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].borrowerIsTaker).toBe(false);
      expect(result.matches[1].borrowerIsTaker).toBe(false);
    });
  });

  describe('Lend Limit Order (borrowerIsTaker = false)', () => {
    it('should set borrowerIsTaker to false when lend limit order matches borrow limit order', () => {
      // Borrow limit order is placed first (becomes maker)
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder);

      // Lend limit order comes in and matches (becomes taker)
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500, // Lender wants 500 bps, borrower willing to pay 600 bps - matches
      });

      const result = engine.submitOrder(lendOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].borrowerIsTaker).toBe(false);
      expect(result.matches[0].lendOrderId).toBe(lendOrder.orderId);
      expect(result.matches[0].borrowOrderId).toBe(borrowOrder.orderId);
    });

    it('should set borrowerIsTaker to false for all matches when lend limit order matches multiple borrow orders', () => {
      // Add multiple borrow orders (all become makers)
      const borrowOrder1: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 700,
      });

      const borrowOrder2: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder1);
      engine.submitOrder(borrowOrder2);

      // Lend limit order matches both (taker)
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 2,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      const result = engine.submitOrder(lendOrder);

      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].borrowerIsTaker).toBe(false);
      expect(result.matches[1].borrowerIsTaker).toBe(false);
    });
  });

  describe('Borrow Market Order (borrowerIsTaker = true)', () => {
    it('should set borrowerIsTaker to true when borrow market order matches lend limit order', () => {
      // Lend limit order is placed first (becomes maker)
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder);

      // Borrow market order comes in (becomes taker)
      const borrowMarket: BorrowMarketOrder = createBorrowMarketOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(borrowMarket);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].borrowerIsTaker).toBe(true);
      expect(result.matches[0].lendOrderId).toBe(lendOrder.orderId);
      expect(result.matches[0].borrowOrderId).toBe(borrowMarket.orderId);
    });

    it('should set borrowerIsTaker to true for all matches when borrow market order matches multiple lend orders', () => {
      // Add multiple lend orders (all become makers)
      const lendOrder1: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 400,
      });

      const lendOrder2: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // Borrow market order matches both (taker)
      const borrowMarket: BorrowMarketOrder = createBorrowMarketOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 2,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(borrowMarket);

      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].borrowerIsTaker).toBe(true);
      expect(result.matches[1].borrowerIsTaker).toBe(true);
    });
  });

  describe('Borrow Limit Order (borrowerIsTaker = true)', () => {
    it('should set borrowerIsTaker to true when borrow limit order matches lend limit order', () => {
      // Lend limit order is placed first (becomes maker)
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder);

      // Borrow limit order comes in and matches (becomes taker)
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600, // Borrower willing to pay 600 bps, lender wants 500 bps - matches
      });

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].borrowerIsTaker).toBe(true);
      expect(result.matches[0].lendOrderId).toBe(lendOrder.orderId);
      expect(result.matches[0].borrowOrderId).toBe(borrowOrder.orderId);
    });

    it('should set borrowerIsTaker to true for all matches when borrow limit order matches multiple lend orders', () => {
      // Add multiple lend orders (all become makers)
      const lendOrder1: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 400,
      });

      const lendOrder2: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // Borrow limit order matches both (taker)
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 2,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].borrowerIsTaker).toBe(true);
      expect(result.matches[1].borrowerIsTaker).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should correctly set borrowerIsTaker when limit order instantly matches (acts as taker)', () => {
      // This test verifies that a limit order can be a taker if it matches immediately
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder);

      // Borrow limit order with rate >= lend rate matches instantly (taker)
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500, // Exactly at lend rate - matches instantly
      });

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      // Borrow order is the incoming order (taker), so borrowerIsTaker = true
      expect(result.matches[0].borrowerIsTaker).toBe(true);
    });

    it('should correctly set borrowerIsTaker in partial fill scenarios', () => {
      // Lend order in book (maker)
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder);

      // First borrow order partially fills (taker)
      const borrowOrder1: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '400000',
        remainingAmount: '400000',
        rate: 600,
        settlementFeeAmount: '10000',
      });

      const result1 = engine.submitOrder(borrowOrder1);
      expect(result1.matches).toHaveLength(1);
      expect(result1.matches[0].borrowerIsTaker).toBe(true);

      // Second borrow order also matches remaining (taker)
      const borrowOrder2: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 2,
        originalAmount: '600000',
        remainingAmount: '600000',
        rate: 600,
        settlementFeeAmount: '10000',
      });

      const result2 = engine.submitOrder(borrowOrder2);
      expect(result2.matches).toHaveLength(1);
      expect(result2.matches[0].borrowerIsTaker).toBe(true);
    });

    it('should correctly identify taker across multiple maturities', () => {
      const maturity1 = 1704067200;
      const maturity2 = 1706745600;

      // Add lend orders for both maturities (makers)
      const lendOrder1: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity1],
        timestamp: Date.now(),
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      const lendOrder2: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity2],
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // Borrow market order for both maturities (taker)
      const borrowMarket: BorrowMarketOrder = createBorrowMarketOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity1, maturity2],
        timestamp: Date.now() + 2,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(borrowMarket);

      expect(result.matches).toHaveLength(2);
      // Both matches should have borrowerIsTaker = true
      expect(result.matches[0].borrowerIsTaker).toBe(true);
      expect(result.matches[1].borrowerIsTaker).toBe(true);
    });
  });
});
