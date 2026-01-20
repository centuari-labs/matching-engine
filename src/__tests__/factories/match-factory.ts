import { generateMatchId, generateOrderId, calculateMakerFee, calculateTakerFee } from '../../utils/helpers';
import { matchSchema, type Match } from '../../types/matches';
import { DEFAULT_LOAN_TOKEN, DEFAULT_MATURITY } from './order-factory';

/**
 * Default matched amount used in tests.
 */
export const DEFAULT_MATCHED_AMOUNT = '1000000';

/**
 * Create a Match instance with sensible defaults for tests.
 *
 * @param overrides - Optional overrides for specific fields.
 * @returns A valid Match instance.
 */
export function createMatch(overrides: Partial<Match> = {}): Match {
  const matchedAmount = overrides.matchedAmount ?? DEFAULT_MATCHED_AMOUNT;

  const base: Match = {
    matchId: generateMatchId(),
    lendOrderId: generateOrderId(),
    borrowOrderId: generateOrderId(),
    lenderWallet: '0x1111111111111111111111111111111111111111',
    borrowerWallet: '0x2222222222222222222222222222222222222222',
    matchedAmount,
    rate: 500,
    loanToken: DEFAULT_LOAN_TOKEN,
    maturity: DEFAULT_MATURITY,
    timestamp: Date.now(),
    borrowerIsTaker: true,
    makerFeeAmount: calculateMakerFee(matchedAmount),
    takerFeeAmount: calculateTakerFee(matchedAmount),
    lenderSettlementFeeAmount: '5000',
    borrowerSettlementFeeAmount: '5000',
  };

  const merged: Match = {
    ...base,
    ...overrides,
  };

  return matchSchema.parse(merged);
}

