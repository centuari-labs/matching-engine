import { MatchingEngine } from '../core/matching-engine';
import type {
  LendLimitOrder,
  BorrowLimitOrder,
  LendMarketOrder,
  BorrowMarketOrder,
} from '../types/orders';
import { OrderSide, OrderType, OrderStatus } from '../types/orders';
import {
  calculateMakerFee,
  calculateTakerFee,
  generateOrderId,
} from '../utils/helpers';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  createBorrowMarketOrder,
} from './factories/order-factory';

/**
 * Tests for maker and taker fee calculations
 *
 * Fee Structure:
 * - Maker fee: 0.1% of matched amount (1/1000)
 * - Taker fee: 0.2% of matched amount (2/1000)
 *
 * Fee Assignment:
 * - When borrowerIsTaker = true: Borrower pays taker fee (0.2%), Lender pays maker fee (0.1%)
 * - When borrowerIsTaker = false: Lender pays taker fee (0.2%), Borrower pays maker fee (0.1%)
 */
describe('Maker/Taker Fee Calculations', () => {
  let engine: MatchingEngine;
  const loanToken = '0x1234567890123456789012345678901234567890';
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  const maturity = 1704067200;

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  describe('Fee Calculation Helper Functions', () => {
    describe('calculateMakerFee', () => {
      it('should calculate 0.1% fee for exact divisible amounts', () => {
        expect(calculateMakerFee('1000000', 10)).toBe('1000'); // 0.1% of 1,000,000
        expect(calculateMakerFee('10000000', 10)).toBe('10000'); // 0.1% of 10,000,000
        expect(calculateMakerFee('100000', 10)).toBe('100'); // 0.1% of 100,000
      });

      it('should use floor division for amounts not divisible by 1000', () => {
        // 1,234,567 * 0.1% = 1234.567, should floor to 1234
        expect(calculateMakerFee('1234567', 10)).toBe('1234');
        // 999 * 0.1% = 0.999, should floor to 0
        expect(calculateMakerFee('999', 10)).toBe('0');
        // 1001 * 0.1% = 1.001, should floor to 1
        expect(calculateMakerFee('1001', 10)).toBe('1');
      });

      it('should handle small amounts correctly', () => {
        expect(calculateMakerFee('1000', 10)).toBe('1'); // Minimum that produces fee
        expect(calculateMakerFee('999', 10)).toBe('0'); // Below minimum
        expect(calculateMakerFee('1', 10)).toBe('0'); // Very small
      });

      it('should handle large amounts correctly', () => {
        const largeAmount = '1000000000000000000'; // 1e18
        const expectedFee = '1000000000000000'; // 0.1% of 1e18
        expect(calculateMakerFee(largeAmount, 10)).toBe(expectedFee);
      });
    });

    describe('calculateTakerFee', () => {
      it('should calculate 0.2% fee for exact divisible amounts', () => {
        expect(calculateTakerFee('1000000', 20)).toBe('2000'); // 0.2% of 1,000,000
        expect(calculateTakerFee('10000000', 20)).toBe('20000'); // 0.2% of 10,000,000
        expect(calculateTakerFee('100000', 20)).toBe('200'); // 0.2% of 100,000
      });

      it('should use floor division for amounts not divisible by 1000', () => {
        // 1,234,567 * 0.2% = 2469.134, should floor to 2469
        expect(calculateTakerFee('1234567', 20)).toBe('2469');
        // 999 * 0.2% = 1.998, should floor to 1
        expect(calculateTakerFee('999', 20)).toBe('1');
        // 1001 * 0.2% = 2.002, should floor to 2
        expect(calculateTakerFee('1001', 20)).toBe('2');
      });

      it('should handle small amounts correctly', () => {
        expect(calculateTakerFee('500', 20)).toBe('1'); // Minimum that produces fee
        expect(calculateTakerFee('499', 20)).toBe('0'); // Below minimum
        expect(calculateTakerFee('1', 20)).toBe('0'); // Very small
      });

      it('should handle large amounts correctly', () => {
        const largeAmount = '1000000000000000000'; // 1e18
        const expectedFee = '2000000000000000'; // 0.2% of 1e18
        expect(calculateTakerFee(largeAmount, 20)).toBe(expectedFee);
      });

      it('should calculate taker fee as approximately double maker fee (within floor division precision)', () => {
        const testAmounts = ['1000000', '1234567', '999', '1001', '1000000000000000000'];
        for (const amount of testAmounts) {
          const makerFee = calculateMakerFee(amount, 10);
          const takerFee = calculateTakerFee(amount, 20);
          // Due to floor division, taker fee may not be exactly 2x maker fee
          // But it should be calculated as floor(amount * 2 / 1000)
          const expectedTakerFee = ((BigInt(amount) * 2n) / 1000n).toString();
          expect(takerFee).toBe(expectedTakerFee);
          // Verify taker fee is at least close to double maker fee (within 1 due to floor division)
          const makerFeeBigInt = BigInt(makerFee);
          const takerFeeBigInt = BigInt(takerFee);
          // Taker fee can be 2x maker fee, 2x maker fee - 1, or 2x maker fee + 1 (due to floor division)
          // This happens because floor(amount * 2 / 1000) != floor(amount / 1000) * 2
          expect(takerFeeBigInt).toBeGreaterThanOrEqual(makerFeeBigInt * 2n - 1n);
          expect(takerFeeBigInt).toBeLessThanOrEqual(makerFeeBigInt * 2n + 1n);
        }
      });
    });
  });

  describe('Fee Assignment: Lend Market Order (borrowerIsTaker = false)', () => {
    it('should assign fees correctly when lend market order matches borrow limit order', () => {
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
      const match = result.matches[0];
      expect(match.borrowerIsTaker).toBe(false);
      // Borrower is maker → pays 0.1% maker fee
      expect(match.makerFeeAmount).toBe(calculateMakerFee('1000000', 10));
      expect(match.makerFeeAmount).toBe('1000');
      // Lender is taker → pays 0.2% taker fee
      expect(match.takerFeeAmount).toBe(calculateTakerFee('1000000', 20));
      expect(match.takerFeeAmount).toBe('2000');
    });

    it('should calculate fees correctly for amounts not divisible by 1000', () => {
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '1234567',
        remainingAmount: '1234567',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder);

      const lendMarket: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '1234567',
        remainingAmount: '1234567',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(lendMarket);

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      expect(match.borrowerIsTaker).toBe(false);
      expect(match.makerFeeAmount).toBe(calculateMakerFee('1234567', 10));
      expect(match.makerFeeAmount).toBe('1234');
      expect(match.takerFeeAmount).toBe(calculateTakerFee('1234567', 20));
      expect(match.takerFeeAmount).toBe('2469');
    });

    it('should calculate fees correctly for multiple matches', () => {
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
      // First match: 500,000
      expect(result.matches[0].borrowerIsTaker).toBe(false);
      expect(result.matches[0].makerFeeAmount).toBe(calculateMakerFee('500000', 10));
      expect(result.matches[0].makerFeeAmount).toBe('500');
      expect(result.matches[0].takerFeeAmount).toBe(calculateTakerFee('500000', 20));
      expect(result.matches[0].takerFeeAmount).toBe('1000');
      // Second match: 500,000
      expect(result.matches[1].borrowerIsTaker).toBe(false);
      expect(result.matches[1].makerFeeAmount).toBe(calculateMakerFee('500000', 10));
      expect(result.matches[1].makerFeeAmount).toBe('500');
      expect(result.matches[1].takerFeeAmount).toBe(calculateTakerFee('500000', 20));
      expect(result.matches[1].takerFeeAmount).toBe('1000');
    });
  });

  describe('Fee Assignment: Lend Limit Order (borrowerIsTaker = false)', () => {
    it('should assign fees correctly when lend limit order matches borrow limit order', () => {
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
        rate: 500,
      });

      const result = engine.submitOrder(lendOrder);

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      expect(match.borrowerIsTaker).toBe(false);
      // Borrower is maker → pays 0.1% maker fee
      expect(match.makerFeeAmount).toBe(calculateMakerFee('1000000', 10));
      expect(match.makerFeeAmount).toBe('1000');
      // Lender is taker → pays 0.2% taker fee
      expect(match.takerFeeAmount).toBe(calculateTakerFee('1000000', 20));
      expect(match.takerFeeAmount).toBe('2000');
    });

    it('should calculate fees correctly for partial fills', () => {
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

      // Lend order that partially fills
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '750000',
        remainingAmount: '750000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      const result = engine.submitOrder(lendOrder);

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      expect(match.borrowerIsTaker).toBe(false);
      expect(match.matchedAmount).toBe('750000');
      expect(match.makerFeeAmount).toBe(calculateMakerFee('750000', 10));
      expect(match.makerFeeAmount).toBe('750');
      expect(match.takerFeeAmount).toBe(calculateTakerFee('750000', 20));
      expect(match.takerFeeAmount).toBe('1500');
    });
  });

  describe('Fee Assignment: Borrow Market Order (borrowerIsTaker = true)', () => {
    it('should assign fees correctly when borrow market order matches lend limit order', () => {
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
      const match = result.matches[0];
      expect(match.borrowerIsTaker).toBe(true);
      // Lender is maker → pays 0.1% maker fee
      expect(match.makerFeeAmount).toBe(calculateMakerFee('1000000', 10));
      expect(match.makerFeeAmount).toBe('1000');
      // Borrower is taker → pays 0.2% taker fee
      expect(match.takerFeeAmount).toBe(calculateTakerFee('1000000', 20));
      expect(match.takerFeeAmount).toBe('2000');
    });

    it('should calculate fees correctly for amounts not divisible by 1000', () => {
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '1234567',
        remainingAmount: '1234567',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder);

      const borrowMarket: BorrowMarketOrder = createBorrowMarketOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '1234567',
        remainingAmount: '1234567',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(borrowMarket);

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      expect(match.borrowerIsTaker).toBe(true);
      expect(match.makerFeeAmount).toBe(calculateMakerFee('1234567', 10));
      expect(match.makerFeeAmount).toBe('1234');
      expect(match.takerFeeAmount).toBe(calculateTakerFee('1234567', 20));
      expect(match.takerFeeAmount).toBe('2469');
    });

    it('should calculate fees correctly for multiple matches', () => {
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
      // First match: 500,000
      expect(result.matches[0].borrowerIsTaker).toBe(true);
      expect(result.matches[0].makerFeeAmount).toBe(calculateMakerFee('500000', 10));
      expect(result.matches[0].makerFeeAmount).toBe('500');
      expect(result.matches[0].takerFeeAmount).toBe(calculateTakerFee('500000', 20));
      expect(result.matches[0].takerFeeAmount).toBe('1000');
      // Second match: 500,000
      expect(result.matches[1].borrowerIsTaker).toBe(true);
      expect(result.matches[1].makerFeeAmount).toBe(calculateMakerFee('500000', 10));
      expect(result.matches[1].makerFeeAmount).toBe('500');
      expect(result.matches[1].takerFeeAmount).toBe(calculateTakerFee('500000', 20));
      expect(result.matches[1].takerFeeAmount).toBe('1000');
    });
  });

  describe('Fee Assignment: Borrow Limit Order (borrowerIsTaker = true)', () => {
    it('should assign fees correctly when borrow limit order matches lend limit order', () => {
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
        rate: 600,
      });

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      expect(match.borrowerIsTaker).toBe(true);
      // Lender is maker → pays 0.1% maker fee
      expect(match.makerFeeAmount).toBe(calculateMakerFee('1000000', 10));
      expect(match.makerFeeAmount).toBe('1000');
      // Borrower is taker → pays 0.2% taker fee
      expect(match.takerFeeAmount).toBe(calculateTakerFee('1000000', 20));
      expect(match.takerFeeAmount).toBe('2000');
    });

    it('should calculate fees correctly for partial fills', () => {
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

      // Borrow order that partially fills
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '750000',
        remainingAmount: '750000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      const result = engine.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      expect(match.borrowerIsTaker).toBe(true);
      expect(match.matchedAmount).toBe('750000');
      expect(match.makerFeeAmount).toBe(calculateMakerFee('750000', 10));
      expect(match.makerFeeAmount).toBe('750');
      expect(match.takerFeeAmount).toBe(calculateTakerFee('750000', 20));
      expect(match.takerFeeAmount).toBe('1500');
    });
  });

  describe('Edge Cases', () => {
    it('should handle very small amounts that produce zero fees', () => {
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '999',
        remainingAmount: '999',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder);

      const lendMarket: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '999',
        remainingAmount: '999',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(lendMarket);

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      // Maker fee: 999 * 0.1% = 0.999 → floor to 0
      expect(match.makerFeeAmount).toBe('0');
      // Taker fee: 999 * 0.2% = 1.998 → floor to 1
      expect(match.takerFeeAmount).toBe('1');
    });

    it('should handle minimum amounts that produce fees', () => {
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '1000',
        remainingAmount: '1000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder);

      const lendMarket: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '1000',
        remainingAmount: '1000',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(lendMarket);

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      // Maker fee: 1000 * 0.1% = 1
      expect(match.makerFeeAmount).toBe('1');
      // Taker fee: 1000 * 0.2% = 2
      expect(match.takerFeeAmount).toBe('2');
    });

    it('should handle very large amounts correctly', () => {
      const largeAmount = '1000000000000000000'; // 1e18
      const expectedMakerFee = calculateMakerFee(largeAmount, 10);
      const expectedTakerFee = calculateTakerFee(largeAmount, 20);

      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: largeAmount,
        remainingAmount: largeAmount,
        settlementFeeAmount: '10000',
        rate: 600,
      });

      engine.submitOrder(borrowOrder);

      const lendMarket: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: largeAmount,
        remainingAmount: largeAmount,
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(lendMarket);

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0];
      expect(match.makerFeeAmount).toBe(expectedMakerFee);
      expect(match.takerFeeAmount).toBe(expectedTakerFee);
      // Verify taker fee is approximately double maker fee (within 1 due to floor division)
      const makerFeeBigInt = BigInt(match.makerFeeAmount);
      const takerFeeBigInt = BigInt(match.takerFeeAmount);
      // Taker fee can be 2x maker fee, 2x maker fee - 1, or 2x maker fee + 1 (due to floor division)
      // This happens because floor(amount * 2 / 1000) != floor(amount / 1000) * 2
      expect(takerFeeBigInt).toBeGreaterThanOrEqual(makerFeeBigInt * 2n - 1n);
      expect(takerFeeBigInt).toBeLessThanOrEqual(makerFeeBigInt * 2n + 1n);
    });

    it('should calculate fees correctly for multiple partial matches with different amounts', () => {
      const lendOrder1: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now(),
        originalAmount: '333333',
        remainingAmount: '333333',
        settlementFeeAmount: '10000',
        rate: 400,
      });

      const lendOrder2: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 1,
        originalAmount: '444444',
        remainingAmount: '444444',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      const borrowMarket: BorrowMarketOrder = createBorrowMarketOrder({
        walletAddress: walletAddress2,
        loanToken,
        maturities: [maturity],
        timestamp: Date.now() + 2,
        originalAmount: '777777',
        remainingAmount: '777777',
        settlementFeeAmount: '10000',
      });

      const result = engine.submitOrder(borrowMarket);

      expect(result.matches).toHaveLength(2);
      // First match: 333,333
      expect(result.matches[0].borrowerIsTaker).toBe(true);
      expect(result.matches[0].matchedAmount).toBe('333333');
      expect(result.matches[0].makerFeeAmount).toBe(calculateMakerFee('333333', 10));
      expect(result.matches[0].makerFeeAmount).toBe('333');
      expect(result.matches[0].takerFeeAmount).toBe(calculateTakerFee('333333', 20));
      expect(result.matches[0].takerFeeAmount).toBe('666');
      // Second match: 444,444
      expect(result.matches[1].borrowerIsTaker).toBe(true);
      expect(result.matches[1].matchedAmount).toBe('444444');
      expect(result.matches[1].makerFeeAmount).toBe(calculateMakerFee('444444', 10));
      expect(result.matches[1].makerFeeAmount).toBe('444');
      expect(result.matches[1].takerFeeAmount).toBe(calculateTakerFee('444444', 20));
      expect(result.matches[1].takerFeeAmount).toBe('888');
    });

    it('should verify fee assignment is consistent with borrowerIsTaker flag', () => {
      // Test both scenarios to ensure fees are assigned correctly
      const testCases = [
        {
          name: 'borrowerIsTaker = true',
          setupMaker: () => {
            const lendOrder: LendLimitOrder = createLendLimitOrder({
              orderId: generateOrderId(),
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
            return {
              order: {
                orderId: generateOrderId(),
                walletAddress: walletAddress2,
                loanToken,
                maturities: [maturity],
                timestamp: Date.now() + 1,
                side: OrderSide.Borrow,
                type: OrderType.Market,
                status: OrderStatus.Open,
                originalAmount: '1000000',
                remainingAmount: '1000000',
                settlementFeeAmount: '10000',
              } as BorrowMarketOrder,
              expectedBorrowerIsTaker: true,
            };
          },
        },
        {
          name: 'borrowerIsTaker = false',
          setupMaker: () => {
            const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
              orderId: generateOrderId(),
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
            return {
              order: {
                orderId: generateOrderId(),
                walletAddress: walletAddress1,
                loanToken,
                maturities: [maturity],
                timestamp: Date.now() + 1,
                side: OrderSide.Lend,
                type: OrderType.Market,
                status: OrderStatus.Open,
                originalAmount: '1000000',
                remainingAmount: '1000000',
                settlementFeeAmount: '10000',
              } as LendMarketOrder,
              expectedBorrowerIsTaker: false,
            };
          },
        },
      ];

      for (const testCase of testCases) {
        engine = new MatchingEngine(); // Reset for each test case
        const { order, expectedBorrowerIsTaker } = testCase.setupMaker();
        const result = engine.submitOrder(order);

        expect(result.matches).toHaveLength(1);
        const match = result.matches[0];
        expect(match.borrowerIsTaker).toBe(expectedBorrowerIsTaker);

        // Verify fees are always calculated correctly
        expect(match.makerFeeAmount).toBe(calculateMakerFee(match.matchedAmount, 10));
        expect(match.takerFeeAmount).toBe(calculateTakerFee(match.matchedAmount, 20));

        // Verify taker fee is approximately double maker fee (within 1 due to floor division)
        const makerFeeBigInt = BigInt(match.makerFeeAmount);
        const takerFeeBigInt = BigInt(match.takerFeeAmount);
        // Taker fee can be 2x maker fee, 2x maker fee - 1, or 2x maker fee + 1 (due to floor division)
        // This happens because floor(amount * 2 / 1000) != floor(amount / 1000) * 2
        expect(takerFeeBigInt).toBeGreaterThanOrEqual(makerFeeBigInt * 2n - 1n);
        expect(takerFeeBigInt).toBeLessThanOrEqual(makerFeeBigInt * 2n + 1n);
      }
    });
  });
});
