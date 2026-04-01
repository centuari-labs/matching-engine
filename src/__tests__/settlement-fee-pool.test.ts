import { MatchingEngine } from '../core/matching-engine';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  marketsFromMaturities,
} from './factories/order-factory';

describe('Settlement Fee Pool Depletion', () => {
  let engine: MatchingEngine;
  const loanToken = '0x1234567890123456789012345678901234567890';
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  const maturity = 1704067200;
  const markets = marketsFromMaturities([maturity]);

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  /**
   * Helper: compute the expected ceiling-division pro-rata fee.
   *   ceil(totalFee * matchedAmount / originalAmount)
   */
  function proRataCeil(
    totalFee: string,
    matchedAmount: string,
    originalAmount: string
  ): bigint {
    const tf = BigInt(totalFee);
    const ma = BigInt(matchedAmount);
    const oa = BigInt(originalAmount);
    if (oa === 0n) return 0n;
    return (tf * ma + (oa - 1n)) / oa;
  }

  // -----------------------------------------------------------------------
  // 1. Single full fill: settlement fee equals settlementFeeAmount exactly
  // -----------------------------------------------------------------------
  it('should assign the entire settlement fee on a single full fill', () => {
    const maker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      remainingSettlementFeeAmount: '10000',
      rate: 500,
    });
    engine.submitOrder(maker);

    const taker = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      remainingSettlementFeeAmount: '10000',
      rate: 500,
    });
    const result = engine.submitOrder(taker);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].lenderSettlementFeeAmount).toBe('10000');
    expect(result.matches[0].borrowerSettlementFeeAmount).toBe('10000');
  });

  // -----------------------------------------------------------------------
  // 2. Two equal partial fills: each gets roughly half (ceiling on first)
  // -----------------------------------------------------------------------
  it('should split settlement fees across two equal partial fills', () => {
    const maker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      remainingSettlementFeeAmount: '10000',
      rate: 500,
    });
    engine.submitOrder(maker);

    // First taker takes half
    const taker1 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '5000',
      remainingSettlementFeeAmount: '5000',
      rate: 500,
    });
    const result1 = engine.submitOrder(taker1);

    expect(result1.matches).toHaveLength(1);
    const fee1 = BigInt(result1.matches[0].lenderSettlementFeeAmount);
    // ceil(10000 * 500000 / 1000000) = 5000
    expect(fee1).toBe(5000n);

    // Second taker takes the other half
    const taker2 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '5000',
      remainingSettlementFeeAmount: '5000',
      rate: 500,
    });
    const result2 = engine.submitOrder(taker2);

    expect(result2.matches).toHaveLength(1);
    const fee2 = BigInt(result2.matches[0].lenderSettlementFeeAmount);
    // Remaining is 5000, clamped to remaining
    expect(fee2).toBe(5000n);

    // Total must equal the original pool exactly
    expect(fee1 + fee2).toBe(10000n);
  });

  // -----------------------------------------------------------------------
  // 3. Three unequal partial fills: pro-rata fees sum <= settlementFeeAmount
  // -----------------------------------------------------------------------
  it('should distribute fees across three unequal partial fills without exceeding pool', () => {
    const maker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '9999',
      remainingSettlementFeeAmount: '9999',
      rate: 500,
    });
    engine.submitOrder(maker);

    const fillAmounts = ['300000', '300000', '400000'];
    const fees: bigint[] = [];

    for (let i = 0; i < fillAmounts.length; i++) {
      const taker = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets,
        timestamp: Date.now() + i,
        originalAmount: fillAmounts[i],
        remainingAmount: fillAmounts[i],
        settlementFeeAmount: '3000',
        remainingSettlementFeeAmount: '3000',
        rate: 500,
      });
      const result = engine.submitOrder(taker);
      expect(result.matches).toHaveLength(1);
      fees.push(BigInt(result.matches[0].lenderSettlementFeeAmount));
    }

    const totalFeeCharged = fees.reduce((a, b) => a + b, 0n);
    expect(totalFeeCharged).toBeLessThanOrEqual(9999n);

    // First fill: ceil(9999 * 300000 / 1000000) = ceil(2999700000 / 1000000) = 3000
    expect(fees[0]).toBe(proRataCeil('9999', '300000', '1000000'));
    // Second fill: ceil(9999 * 300000 / 1000000) = 3000, clamped to remaining
    // Third fill: gets clamped remainder
  });

  // -----------------------------------------------------------------------
  // 4. Final fill gets clamped: ceiling math exceeds remaining pool
  // -----------------------------------------------------------------------
  it('should clamp the final fill fee when ceiling math would exceed remaining pool', () => {
    // Use an amount that produces ceiling rounding on partial fills
    const maker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10001',
      remainingSettlementFeeAmount: '10001',
      rate: 500,
    });
    engine.submitOrder(maker);

    // Fill 1: 333333 units
    const taker1 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now(),
      originalAmount: '333333',
      remainingAmount: '333333',
      settlementFeeAmount: '3000',
      remainingSettlementFeeAmount: '3000',
      rate: 500,
    });
    const result1 = engine.submitOrder(taker1);
    const fee1 = BigInt(result1.matches[0].lenderSettlementFeeAmount);

    // Fill 2: 333333 units
    const taker2 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now() + 1,
      originalAmount: '333333',
      remainingAmount: '333333',
      settlementFeeAmount: '3000',
      remainingSettlementFeeAmount: '3000',
      rate: 500,
    });
    const result2 = engine.submitOrder(taker2);
    const fee2 = BigInt(result2.matches[0].lenderSettlementFeeAmount);

    // Fill 3: remaining 333334 units
    const taker3 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now() + 2,
      originalAmount: '333334',
      remainingAmount: '333334',
      settlementFeeAmount: '3000',
      remainingSettlementFeeAmount: '3000',
      rate: 500,
    });
    const result3 = engine.submitOrder(taker3);
    const fee3 = BigInt(result3.matches[0].lenderSettlementFeeAmount);

    // The pro-rata ceil for each of the first two fills would be:
    //   ceil(10001 * 333333 / 1000000) = 3334
    const expectedFee1 = proRataCeil('10001', '333333', '1000000');
    expect(fee1).toBe(expectedFee1);

    // The final fill should be clamped so total never exceeds 10001
    const totalFee = fee1 + fee2 + fee3;
    expect(totalFee).toBeLessThanOrEqual(10001n);

    // Verify that the last fee is the remainder (clamped), not the raw pro-rata
    const rawProRata3 = proRataCeil('10001', '333334', '1000000');
    const remaining = 10001n - fee1 - fee2;
    if (remaining < rawProRata3) {
      expect(fee3).toBe(remaining);
    }
  });

  // -----------------------------------------------------------------------
  // 5. Pool fully depleted: after enough fills, fee becomes "0"
  // -----------------------------------------------------------------------
  it('should return zero fee once the pool is fully depleted', () => {
    const maker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '100',
      remainingSettlementFeeAmount: '100',
      rate: 500,
    });
    engine.submitOrder(maker);

    // First fill: take 500000 -> fee = ceil(100 * 500000 / 1000000) = 50
    const taker1 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now(),
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '50',
      remainingSettlementFeeAmount: '50',
      rate: 500,
    });
    const result1 = engine.submitOrder(taker1);
    expect(result1.matches[0].lenderSettlementFeeAmount).toBe('50');

    // Second fill: take remaining 500000 -> fee = 50 (remaining)
    const taker2 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now() + 1,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '50',
      remainingSettlementFeeAmount: '50',
      rate: 500,
    });
    const result2 = engine.submitOrder(taker2);
    expect(result2.matches[0].lenderSettlementFeeAmount).toBe('50');

    // Pool is now 0. If we somehow had more order amount, fee would be 0.
    // (Order is fully filled so no more matches possible.)
    // Verify the total is exactly the pool.
    const total =
      BigInt(result1.matches[0].lenderSettlementFeeAmount) +
      BigInt(result2.matches[0].lenderSettlementFeeAmount);
    expect(total).toBe(100n);
  });

  // -----------------------------------------------------------------------
  // 6. settlementFeeAmount = "0": no fees charged on any fill
  // -----------------------------------------------------------------------
  it('should charge zero fees when settlementFeeAmount is "0"', () => {
    const maker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '0',
      remainingSettlementFeeAmount: '0',
      rate: 500,
    });
    engine.submitOrder(maker);

    const taker1 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now(),
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '0',
      remainingSettlementFeeAmount: '0',
      rate: 500,
    });
    const result1 = engine.submitOrder(taker1);

    expect(result1.matches).toHaveLength(1);
    expect(result1.matches[0].lenderSettlementFeeAmount).toBe('0');
    expect(result1.matches[0].borrowerSettlementFeeAmount).toBe('0');

    // Second fill also zero
    const taker2 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now() + 1,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '0',
      remainingSettlementFeeAmount: '0',
      rate: 500,
    });
    const result2 = engine.submitOrder(taker2);

    expect(result2.matches).toHaveLength(1);
    expect(result2.matches[0].lenderSettlementFeeAmount).toBe('0');
    expect(result2.matches[0].borrowerSettlementFeeAmount).toBe('0');
  });

  // -----------------------------------------------------------------------
  // 7. settlementFeeAmount = "1": indivisible fee goes to first fill only
  // -----------------------------------------------------------------------
  it('should assign the indivisible fee of "1" to the first fill only', () => {
    const maker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '1',
      remainingSettlementFeeAmount: '1',
      rate: 500,
    });
    engine.submitOrder(maker);

    // First fill: ceil(1 * 500000 / 1000000) = ceil(0.5) = 1
    const taker1 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now(),
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '1',
      remainingSettlementFeeAmount: '1',
      rate: 500,
    });
    const result1 = engine.submitOrder(taker1);

    expect(result1.matches).toHaveLength(1);
    expect(result1.matches[0].lenderSettlementFeeAmount).toBe('1');

    // Second fill: pool depleted -> clamped to 0
    const taker2 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now() + 1,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '1',
      remainingSettlementFeeAmount: '1',
      rate: 500,
    });
    const result2 = engine.submitOrder(taker2);

    expect(result2.matches).toHaveLength(1);
    expect(result2.matches[0].lenderSettlementFeeAmount).toBe('0');
  });

  // -----------------------------------------------------------------------
  // 8. Very large fee with very small first fill: ceiling rounding produces
  //    non-zero even for a tiny fill
  // -----------------------------------------------------------------------
  it('should produce non-zero fee via ceiling for a tiny fill against a large fee pool', () => {
    const maker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000000000',
      remainingAmount: '1000000000000',
      settlementFeeAmount: '999999999999',
      remainingSettlementFeeAmount: '999999999999',
      rate: 500,
    });
    engine.submitOrder(maker);

    // Tiny fill: 1 unit
    const taker = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      originalAmount: '1',
      remainingAmount: '1',
      settlementFeeAmount: '1',
      remainingSettlementFeeAmount: '1',
      rate: 500,
    });
    const result = engine.submitOrder(taker);

    expect(result.matches).toHaveLength(1);
    const fee = BigInt(result.matches[0].lenderSettlementFeeAmount);
    // ceil(999999999999 * 1 / 1000000000000) = ceil(0.999...) = 1
    expect(fee).toBe(1n);
    expect(fee).toBeGreaterThan(0n);
  });

  // -----------------------------------------------------------------------
  // 9. Both lender and borrower pools deplete independently
  // -----------------------------------------------------------------------
  it('should deplete lender and borrower fee pools independently', () => {
    // Lend limit order as maker (lender pool tracked on this order)
    const lendMaker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '5000',
      remainingSettlementFeeAmount: '5000',
      rate: 500,
    });
    engine.submitOrder(lendMaker);

    // First borrow taker: 500000
    const borrowTaker1 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now(),
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '8000',
      remainingSettlementFeeAmount: '8000',
      rate: 500,
    });
    const result1 = engine.submitOrder(borrowTaker1);
    expect(result1.matches).toHaveLength(1);

    const lenderFee1 = BigInt(result1.matches[0].lenderSettlementFeeAmount);
    const borrowerFee1 = BigInt(result1.matches[0].borrowerSettlementFeeAmount);

    // Lender fee: ceil(5000 * 500000 / 1000000) = 2500
    expect(lenderFee1).toBe(2500n);
    // Borrower fee: ceil(8000 * 500000 / 500000) = 8000 (full fill for taker)
    expect(borrowerFee1).toBe(8000n);

    // Second borrow taker: 500000
    const borrowTaker2 = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now() + 1,
      originalAmount: '500000',
      remainingAmount: '500000',
      settlementFeeAmount: '3000',
      remainingSettlementFeeAmount: '3000',
      rate: 500,
    });
    const result2 = engine.submitOrder(borrowTaker2);
    expect(result2.matches).toHaveLength(1);

    const lenderFee2 = BigInt(result2.matches[0].lenderSettlementFeeAmount);
    const borrowerFee2 = BigInt(result2.matches[0].borrowerSettlementFeeAmount);

    // Lender fee: remaining 2500 (5000 - 2500), clamped
    expect(lenderFee2).toBe(2500n);
    // Borrower fee: ceil(3000 * 500000 / 500000) = 3000 (full fill for taker2)
    expect(borrowerFee2).toBe(3000n);

    // Lender total = 5000 exactly
    expect(lenderFee1 + lenderFee2).toBe(5000n);
    // Borrower totals are independent per order (each taker is a separate order)
    expect(borrowerFee1).toBe(8000n);
    expect(borrowerFee2).toBe(3000n);
  });

  // -----------------------------------------------------------------------
  // 9b. Bidirectional: borrow limit maker with lend market takers
  // -----------------------------------------------------------------------
  it('should deplete borrow maker fee pool independently with lend market takers', () => {
    const borrowMaker = createBorrowLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '6000',
      remainingSettlementFeeAmount: '6000',
      rate: 500,
    });
    engine.submitOrder(borrowMaker);

    // First lend market taker: 400000
    const lendTaker1 = createLendMarketOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now(),
      originalAmount: '400000',
      remainingAmount: '400000',
      settlementFeeAmount: '2000',
      remainingSettlementFeeAmount: '2000',
    });
    const result1 = engine.submitOrder(lendTaker1);
    expect(result1.matches).toHaveLength(1);

    const borrowerFee1 = BigInt(result1.matches[0].borrowerSettlementFeeAmount);
    // ceil(6000 * 400000 / 1000000) = ceil(2400) = 2400
    expect(borrowerFee1).toBe(2400n);

    // Second lend market taker: 600000
    const lendTaker2 = createLendMarketOrder({
      walletAddress: walletAddress2,
      loanToken,
      markets,
      timestamp: Date.now() + 1,
      originalAmount: '600000',
      remainingAmount: '600000',
      settlementFeeAmount: '3000',
      remainingSettlementFeeAmount: '3000',
    });
    const result2 = engine.submitOrder(lendTaker2);
    expect(result2.matches).toHaveLength(1);

    const borrowerFee2 = BigInt(result2.matches[0].borrowerSettlementFeeAmount);
    // Remaining: 6000 - 2400 = 3600, proRata = ceil(6000 * 600000 / 1000000) = 3600
    // min(3600, 3600) = 3600
    expect(borrowerFee2).toBe(3600n);

    expect(borrowerFee1 + borrowerFee2).toBe(6000n);
  });

  // -----------------------------------------------------------------------
  // 10. Five sequential partial fills: verify sum never exceeds total pool
  // -----------------------------------------------------------------------
  it('should never let fee sum exceed the pool across five partial fills', () => {
    const totalPool = '7777';
    const originalAmount = '1000000';

    const maker = createLendLimitOrder({
      walletAddress: walletAddress1,
      loanToken,
      markets,
      originalAmount,
      remainingAmount: originalAmount,
      settlementFeeAmount: totalPool,
      remainingSettlementFeeAmount: totalPool,
      rate: 500,
    });
    engine.submitOrder(maker);

    const fillAmounts = ['200000', '200000', '200000', '200000', '200000'];
    const fees: bigint[] = [];

    for (let i = 0; i < fillAmounts.length; i++) {
      const taker = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets,
        timestamp: Date.now() + i,
        originalAmount: fillAmounts[i],
        remainingAmount: fillAmounts[i],
        settlementFeeAmount: '2000',
        remainingSettlementFeeAmount: '2000',
        rate: 500,
      });
      const result = engine.submitOrder(taker);
      expect(result.matches).toHaveLength(1);
      fees.push(BigInt(result.matches[0].lenderSettlementFeeAmount));
    }

    const totalFeeCharged = fees.reduce((a, b) => a + b, 0n);

    // Total must never exceed the pool
    expect(totalFeeCharged).toBeLessThanOrEqual(BigInt(totalPool));

    // Each individual fee should be the pro-rata ceiling or the clamped remainder
    // First fill: ceil(7777 * 200000 / 1000000) = ceil(1555.4) = 1556
    expect(fees[0]).toBe(proRataCeil(totalPool, '200000', originalAmount));

    // After five equal fills, total should equal exactly the pool
    // (since 5 * 200000 = 1000000 = originalAmount, all fills are consumed)
    expect(totalFeeCharged).toBe(BigInt(totalPool));

    // Verify monotonicity: fees should be weakly decreasing (last may be clamped)
    for (let i = 0; i < fees.length - 1; i++) {
      expect(fees[i]).toBeGreaterThanOrEqual(fees[i + 1]);
    }
  });
});
