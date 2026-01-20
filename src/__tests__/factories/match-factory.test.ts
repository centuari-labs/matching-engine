import { createMatch, DEFAULT_MATCHED_AMOUNT } from './match-factory';
import { matchSchema } from '../../types/matches';
import { calculateMakerFee, calculateTakerFee } from '../../utils/helpers';

describe('match-factory', () => {
  it('creates a valid match with default fees and amounts', () => {
    const match = createMatch();

    // Should be valid according to schema
    expect(() => matchSchema.parse(match)).not.toThrow();

    expect(match.matchedAmount).toBe(DEFAULT_MATCHED_AMOUNT);
    expect(match.makerFeeAmount).toBe(calculateMakerFee(DEFAULT_MATCHED_AMOUNT));
    expect(match.takerFeeAmount).toBe(calculateTakerFee(DEFAULT_MATCHED_AMOUNT));
  });

  it('respects overrides for matchedAmount and recomputes fees when provided explicitly', () => {
    const overriddenAmount = '2000000';
    const match = createMatch({
      matchedAmount: overriddenAmount,
      makerFeeAmount: calculateMakerFee(overriddenAmount),
      takerFeeAmount: calculateTakerFee(overriddenAmount),
    });

    expect(match.matchedAmount).toBe(overriddenAmount);
    expect(match.makerFeeAmount).toBe(calculateMakerFee(overriddenAmount));
    expect(match.takerFeeAmount).toBe(calculateTakerFee(overriddenAmount));
  });
});

