import {
  calculateProRataSettlementFee,
  addBigNumbers,
  compareBigNumbers,
} from '../utils/helpers';
import { MatchingEngine } from '../core/matching-engine';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
} from './factories/order-factory';

/**
 * M-2 invariant: the clamp at `minBigNumber(proRata, currentRemaining)`
 * inside `calculateAndConsumeSettlementFee` makes over-collection of
 * settlement fees mathematically impossible across any sequence of
 * partial fills.
 *
 * Pro-rata rounds UP per match, but the residual pool shrinks
 * monotonically and the clamp on the last fill absorbs the rounding
 * overage. We test both the pure function and the realized engine path.
 */
describe('M-12: Settlement fee rounding invariant', () => {
  describe('calculateProRataSettlementFee (unit)', () => {
    it('returns "0" when originalAmount is "0"', () => {
      expect(calculateProRataSettlementFee('100', '50', '0')).toBe('0');
    });

    it('rounds up: 1 unit of 1000 with budget 7 → ceil(7/1000) = 1', () => {
      expect(calculateProRataSettlementFee('7', '1', '1000')).toBe('1');
    });

    it('full fill consumes exactly the full budget', () => {
      expect(calculateProRataSettlementFee('10000', '1000000', '1000000')).toBe('10000');
    });
  });

  describe('Invariant via MatchingEngine — 3-fill clamp behavior', () => {
    it('3 partial fills of an order with budget 100 produce a sum that ≤ 100 and == 100 when fully filled', () => {
      const engine = new MatchingEngine();
      // Maker order: 1_000_000 units, fee budget 100.
      // Three takers of 333_333 + 333_333 + 333_334 = 1_000_000 (fully fills).
      // Pro-rata per fill: ceil(100 * 333333 / 1000000) = 34 (33.333… up).
      // Naive accumulation: 34 + 34 + 34 = 102 > budget — but the clamp
      // on the last fill caps actualFee at remaining = 100 - 34 - 34 = 32,
      // so the sum lands at exactly 100.
      const maker = createLendLimitOrder({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        rate: 500,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '100',
        // Factory leaves remainingSettlementFeeAmount at the base default
        // ('10000') when settlementFeeAmount is overridden. Must set
        // explicitly so the clamp at minBigNumber(proRata, remaining)
        // actually kicks in.
        remainingSettlementFeeAmount: '100',
      });
      engine.submitOrder(maker);

      const takerAmounts = ['333333', '333333', '333334'];
      const takerWallets = [
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '0xcccccccccccccccccccccccccccccccccccccccc',
        '0xdddddddddddddddddddddddddddddddddddddddd',
      ];

      let totalLenderFee = '0';
      for (let i = 0; i < 3; i++) {
        const taker = createBorrowLimitOrder({
          walletAddress: takerWallets[i],
          rate: 500,
          originalAmount: takerAmounts[i],
          remainingAmount: takerAmounts[i],
          settlementFeeAmount: '0',
        });
        const result = engine.submitOrder(taker);
        for (const match of result.matches) {
          totalLenderFee = addBigNumbers(totalLenderFee, match.lenderSettlementFeeAmount);
        }
      }

      // Invariant: sum of per-match fees never exceeds the maker's total budget.
      expect(compareBigNumbers(totalLenderFee, '100')).toBeLessThanOrEqual(0);

      // On full fill, the clamp lands the sum at exactly the budget.
      expect(totalLenderFee).toBe('100');
    });
  });
});
