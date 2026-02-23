import { generateMatchId, generateOrderId, calculateMakerFee, calculateTakerFee } from '../../utils/helpers';
import { matchSchema, type Match } from '../../types/matches';
import { DEFAULT_ASSET_ID, DEFAULT_MARKET_ID } from './order-factory';

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
    lenderAccountId: '550e8400-e29b-41d4-a716-446655440002',
    borrowerAccountId: '550e8400-e29b-41d4-a716-446655440003',
    matchedAmount,
    rate: 500,
    assetId: DEFAULT_ASSET_ID,
    marketId: DEFAULT_MARKET_ID,
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

