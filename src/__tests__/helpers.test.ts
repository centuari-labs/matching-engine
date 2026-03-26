/**
 * Helpers Unit Tests
 *
 * Tests for utility functions in src/utils/helpers.ts
 * Covers: UUID generation, address validation, big number arithmetic,
 * fee calculations, order comparators, and rate calculations.
 */

import {
  generateOrderId,
  generateMatchId,
  validateTokenAddress,
  calculateMatchRate,
  createOrderComparator,
  compareBigNumbers,
  addBigNumbers,
  subtractBigNumbers,
  minBigNumber,
  isZero,
  calculateMakerFee,
  calculateTakerFee,
  calculateProRataSettlementFee,
} from '../utils/helpers';
import { OrderSide } from '../types/orders';
import { createLendLimitOrder, createBorrowLimitOrder } from './factories/order-factory';

describe('helpers', () => {
  describe('generateOrderId', () => {
    it('should return a valid UUID v4 string', () => {
      const id = generateOrderId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateOrderId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('generateMatchId', () => {
    it('should return a valid UUID v4 string', () => {
      const id = generateMatchId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateMatchId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('validateTokenAddress', () => {
    it('should accept a valid Ethereum address', () => {
      expect(validateTokenAddress('0x1234567890123456789012345678901234567890')).toBe(true);
    });

    it('should accept uppercase hex', () => {
      expect(validateTokenAddress('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')).toBe(true);
    });

    it('should accept mixed case hex', () => {
      expect(validateTokenAddress('0xaBcDeF1234567890aBcDeF1234567890aBcDeF12')).toBe(true);
    });

    it('should reject address without 0x prefix', () => {
      expect(validateTokenAddress('1234567890123456789012345678901234567890')).toBe(false);
    });

    it('should reject address that is too short', () => {
      expect(validateTokenAddress('0x12345678901234567890123456789012345678')).toBe(false);
    });

    it('should reject address that is too long', () => {
      expect(validateTokenAddress('0x123456789012345678901234567890123456789012')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(validateTokenAddress('')).toBe(false);
    });

    it('should reject address with invalid hex characters', () => {
      expect(validateTokenAddress('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG')).toBe(false);
    });

    it('should reject address with only 0x prefix', () => {
      expect(validateTokenAddress('0x')).toBe(false);
    });
  });

  describe('calculateMatchRate', () => {
    it('should return min of both rates when both provided', () => {
      expect(calculateMatchRate(500, 600)).toBe(500);
    });

    it('should return lend rate when only lend rate provided', () => {
      expect(calculateMatchRate(500, undefined)).toBe(500);
    });

    it('should return borrow rate when only borrow rate provided', () => {
      expect(calculateMatchRate(undefined, 600)).toBe(600);
    });

    it('should return 0 when both rates are undefined (market vs market)', () => {
      expect(calculateMatchRate(undefined, undefined)).toBe(0);
    });

    it('should handle zero rates', () => {
      expect(calculateMatchRate(0, 500)).toBe(0);
    });

    it('should handle equal rates', () => {
      expect(calculateMatchRate(500, 500)).toBe(500);
    });

    it('should handle maximum basis points', () => {
      expect(calculateMatchRate(10000, 5000)).toBe(5000);
    });
  });

  describe('createOrderComparator', () => {
    describe('LEND side (ascending rate)', () => {
      const comparator = createOrderComparator(OrderSide.Lend);

      it('should sort lower rate before higher rate', () => {
        const a = createLendLimitOrder({ rate: 300, timestamp: 1000 });
        const b = createLendLimitOrder({ rate: 500, timestamp: 1000 });
        expect(comparator(a, b)).toBeLessThan(0);
      });

      it('should sort by timestamp when rates are equal (price-time priority)', () => {
        const a = createLendLimitOrder({ rate: 500, timestamp: 1000 });
        const b = createLendLimitOrder({ rate: 500, timestamp: 2000 });
        expect(comparator(a, b)).toBeLessThan(0);
      });

      it('should return 0 for equal rate and timestamp', () => {
        const a = createLendLimitOrder({ rate: 500, timestamp: 1000 });
        const b = createLendLimitOrder({ rate: 500, timestamp: 1000 });
        expect(comparator(a, b)).toBe(0);
      });

      it('should put market orders (no rate) last', () => {
        const limitOrder = createLendLimitOrder({ rate: 500, timestamp: 1000 });
        const marketOrder = createLendLimitOrder({ timestamp: 1000 });
        // Manually remove rate to simulate market order
        delete (marketOrder as Record<string, unknown>).rate;
        expect(comparator(limitOrder, marketOrder)).toBeLessThan(0);
      });
    });

    describe('BORROW side (descending rate)', () => {
      const comparator = createOrderComparator(OrderSide.Borrow);

      it('should sort higher rate before lower rate', () => {
        const a = createBorrowLimitOrder({ rate: 500, timestamp: 1000 });
        const b = createBorrowLimitOrder({ rate: 300, timestamp: 1000 });
        expect(comparator(a, b)).toBeLessThan(0);
      });

      it('should sort by timestamp when rates are equal', () => {
        const a = createBorrowLimitOrder({ rate: 500, timestamp: 1000 });
        const b = createBorrowLimitOrder({ rate: 500, timestamp: 2000 });
        expect(comparator(a, b)).toBeLessThan(0);
      });

      it('should put market orders (no rate) last', () => {
        const limitOrder = createBorrowLimitOrder({ rate: 500, timestamp: 1000 });
        const marketOrder = createBorrowLimitOrder({ timestamp: 1000 });
        delete (marketOrder as Record<string, unknown>).rate;
        expect(comparator(limitOrder, marketOrder)).toBeLessThan(0);
      });
    });
  });

  describe('compareBigNumbers', () => {
    it('should return 0 for equal numbers', () => {
      expect(compareBigNumbers('100', '100')).toBe(0);
    });

    it('should return negative when a < b', () => {
      expect(compareBigNumbers('100', '200')).toBeLessThan(0);
    });

    it('should return positive when a > b', () => {
      expect(compareBigNumbers('200', '100')).toBeGreaterThan(0);
    });

    it('should handle numbers with different lengths', () => {
      expect(compareBigNumbers('9', '10')).toBeLessThan(0);
    });

    it('should handle leading zeros', () => {
      expect(compareBigNumbers('00100', '100')).toBe(0);
    });

    it('should handle zero values', () => {
      expect(compareBigNumbers('0', '0')).toBe(0);
    });

    it('should handle all-zero strings', () => {
      expect(compareBigNumbers('000', '0')).toBe(0);
    });

    it('should handle very large numbers', () => {
      const big = '999999999999999999999999999999';
      const bigger = '1000000000000000000000000000000';
      expect(compareBigNumbers(big, bigger)).toBeLessThan(0);
    });

    it('should handle same-length different values', () => {
      expect(compareBigNumbers('123', '124')).toBeLessThan(0);
      expect(compareBigNumbers('124', '123')).toBeGreaterThan(0);
    });
  });

  describe('addBigNumbers', () => {
    it('should add two positive numbers', () => {
      expect(addBigNumbers('100', '200')).toBe('300');
    });

    it('should handle adding zero', () => {
      expect(addBigNumbers('100', '0')).toBe('100');
    });

    it('should handle both zeros', () => {
      expect(addBigNumbers('0', '0')).toBe('0');
    });

    it('should handle very large numbers without precision loss', () => {
      const a = '99999999999999999999999999999999';
      const b = '1';
      expect(addBigNumbers(a, b)).toBe('100000000000000000000000000000000');
    });

    it('should handle large sums', () => {
      const a = '500000000000000000000';
      const b = '500000000000000000000';
      expect(addBigNumbers(a, b)).toBe('1000000000000000000000');
    });
  });

  describe('subtractBigNumbers', () => {
    it('should subtract two numbers', () => {
      expect(subtractBigNumbers('200', '100')).toBe('100');
    });

    it('should handle subtracting zero', () => {
      expect(subtractBigNumbers('100', '0')).toBe('100');
    });

    it('should handle equal numbers', () => {
      expect(subtractBigNumbers('100', '100')).toBe('0');
    });

    it('should throw when result would be negative', () => {
      expect(() => subtractBigNumbers('100', '200')).toThrow(
        'Result of subtraction cannot be negative'
      );
    });

    it('should handle very large numbers', () => {
      const a = '1000000000000000000000';
      const b = '999999999999999999999';
      expect(subtractBigNumbers(a, b)).toBe('1');
    });

    it('should throw for 0 - 1', () => {
      expect(() => subtractBigNumbers('0', '1')).toThrow(
        'Result of subtraction cannot be negative'
      );
    });
  });

  describe('minBigNumber', () => {
    it('should return the smaller number', () => {
      expect(minBigNumber('100', '200')).toBe('100');
    });

    it('should return the first when equal', () => {
      expect(minBigNumber('100', '100')).toBe('100');
    });

    it('should return the smaller when reversed', () => {
      expect(minBigNumber('200', '100')).toBe('100');
    });

    it('should handle zero', () => {
      expect(minBigNumber('0', '100')).toBe('0');
    });

    it('should handle large numbers', () => {
      const small = '999999999999999999';
      const large = '1000000000000000000';
      expect(minBigNumber(small, large)).toBe(small);
    });
  });

  describe('isZero', () => {
    it('should return true for "0"', () => {
      expect(isZero('0')).toBe(true);
    });

    it('should return true for "00"', () => {
      expect(isZero('00')).toBe(true);
    });

    it('should return false for "1"', () => {
      expect(isZero('1')).toBe(false);
    });

    it('should return false for large number', () => {
      expect(isZero('1000000000000000000')).toBe(false);
    });
  });

  describe('calculateMakerFee', () => {
    it('should calculate 10bps (0.1%) fee by default', () => {
      // 1,000,000 * 10 / 10000 = 1000
      expect(calculateMakerFee('1000000')).toBe('1000');
    });

    it('should accept custom fee in bps', () => {
      // 1,000,000 * 50 / 10000 = 5000
      expect(calculateMakerFee('1000000', 50)).toBe('5000');
    });

    it('should handle zero fee', () => {
      expect(calculateMakerFee('1000000', 0)).toBe('0');
    });

    it('should handle zero amount', () => {
      expect(calculateMakerFee('0')).toBe('0');
    });

    it('should floor-divide (truncate towards zero)', () => {
      // 999 * 10 / 10000 = 0.999 → floors to 0
      expect(calculateMakerFee('999', 10)).toBe('0');
    });

    it('should handle very large amounts without precision loss', () => {
      // 10^30 * 10 / 10000 = 10^27
      const amount = '1000000000000000000000000000000';
      expect(calculateMakerFee(amount, 10)).toBe('1000000000000000000000000000');
    });

    it('should handle max fee (10000 bps = 100%)', () => {
      expect(calculateMakerFee('1000000', 10000)).toBe('1000000');
    });

    it('should handle 1 bps fee', () => {
      // 1,000,000 * 1 / 10000 = 100
      expect(calculateMakerFee('1000000', 1)).toBe('100');
    });

    it('should handle amount that produces rounding', () => {
      // 7 * 10 / 10000 = 0.007 → 0
      expect(calculateMakerFee('7', 10)).toBe('0');
      // 10001 * 10 / 10000 = 10.001 → 10
      expect(calculateMakerFee('10001', 10)).toBe('10');
    });
  });

  describe('calculateTakerFee', () => {
    it('should calculate 20bps (0.2%) fee by default', () => {
      // 1,000,000 * 20 / 10000 = 2000
      expect(calculateTakerFee('1000000')).toBe('2000');
    });

    it('should accept custom fee in bps', () => {
      // 1,000,000 * 100 / 10000 = 10000
      expect(calculateTakerFee('1000000', 100)).toBe('10000');
    });

    it('should handle zero fee', () => {
      expect(calculateTakerFee('1000000', 0)).toBe('0');
    });

    it('should handle zero amount', () => {
      expect(calculateTakerFee('0')).toBe('0');
    });

    it('should floor-divide', () => {
      // 499 * 20 / 10000 = 0.998 → 0
      expect(calculateTakerFee('499', 20)).toBe('0');
    });
  });

  describe('calculateProRataSettlementFee', () => {
    it('should return full fee when matched equals original', () => {
      expect(calculateProRataSettlementFee('10000', '1000000', '1000000')).toBe('10000');
    });

    it('should return proportional fee for partial fill', () => {
      // ceil(10000 * 500000 / 1000000) = ceil(5000) = 5000
      expect(calculateProRataSettlementFee('10000', '500000', '1000000')).toBe('5000');
    });

    it('should round up (ceiling division)', () => {
      // ceil(10 * 1 / 3) = ceil(3.33) = 4
      expect(calculateProRataSettlementFee('10', '1', '3')).toBe('4');
    });

    it('should return 0 when totalFee is 0', () => {
      expect(calculateProRataSettlementFee('0', '500000', '1000000')).toBe('0');
    });

    it('should return 0 when matchedAmount is 0', () => {
      expect(calculateProRataSettlementFee('10000', '0', '1000000')).toBe('0');
    });

    it('should return 0 when originalAmount is 0 (division by zero guard)', () => {
      expect(calculateProRataSettlementFee('10000', '500000', '0')).toBe('0');
    });

    it('should handle very large numbers', () => {
      const totalFee = '1000000000000000000';
      const matched = '500000000000000000';
      const original = '1000000000000000000';
      expect(calculateProRataSettlementFee(totalFee, matched, original)).toBe('500000000000000000');
    });

    it('should round up even for small remainders', () => {
      // ceil(100 * 1 / 99) = ceil(1.0101...) = 2
      expect(calculateProRataSettlementFee('100', '1', '99')).toBe('2');
    });

    it('should handle fee=1, matched=1, original=large', () => {
      // ceil(1 * 1 / 1000000) = ceil(0.000001) = 1
      expect(calculateProRataSettlementFee('1', '1', '1000000')).toBe('1');
    });
  });
});
