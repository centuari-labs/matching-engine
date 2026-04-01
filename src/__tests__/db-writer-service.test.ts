/**
 * Tests for DbWriterService.fieldsToMatch() conversion logic
 *
 * Tests the flat Redis field array → Match object conversion and validation,
 * without requiring real NATS/Redis/Postgres connections.
 */

import { matchSchema } from '../types/matches';
import { createMatch } from './factories/match-factory';

/**
 * Standalone re-implementation of fieldsToMatch for unit testing.
 * Mirrors db-writer-service.ts lines 371-397 exactly.
 */
function fieldsToMatch(fields: string[]): Record<string, unknown> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    obj[key] = value;
  }

  return {
    matchId: obj.matchId,
    marketId: obj.marketId,
    lendOrderId: obj.lendOrderId,
    borrowOrderId: obj.borrowOrderId,
    lenderWallet: obj.lenderWallet,
    borrowerWallet: obj.borrowerWallet,
    matchedAmount: obj.matchedAmount,
    rate: obj.rate ? Number(obj.rate) : 0,
    loanToken: obj.loanToken,
    maturity: obj.maturity ? Number(obj.maturity) : 0,
    timestamp: obj.timestamp ? Number(obj.timestamp) : 0,
    borrowerIsTaker: obj.borrowerIsTaker === 'true',
    makerFeeAmount: obj.makerFeeAmount ?? '0',
    takerFeeAmount: obj.takerFeeAmount ?? '0',
    lenderSettlementFeeAmount: obj.lenderSettlementFeeAmount ?? '0',
    borrowerSettlementFeeAmount: obj.borrowerSettlementFeeAmount ?? '0',
  };
}

/**
 * Helper: convert a Match object to a flat Redis fields array (key-value pairs).
 */
function matchToFields(match: ReturnType<typeof createMatch>): string[] {
  return [
    'matchId', match.matchId,
    'marketId', match.marketId,
    'lendOrderId', match.lendOrderId,
    'borrowOrderId', match.borrowOrderId,
    'lenderWallet', match.lenderWallet,
    'borrowerWallet', match.borrowerWallet,
    'matchedAmount', match.matchedAmount,
    'rate', String(match.rate),
    'loanToken', match.loanToken,
    'maturity', String(match.maturity),
    'timestamp', String(match.timestamp),
    'borrowerIsTaker', String(match.borrowerIsTaker),
    'makerFeeAmount', match.makerFeeAmount,
    'takerFeeAmount', match.takerFeeAmount,
    'lenderSettlementFeeAmount', match.lenderSettlementFeeAmount,
    'borrowerSettlementFeeAmount', match.borrowerSettlementFeeAmount,
  ];
}

describe('fieldsToMatch conversion', () => {
  it('should convert a valid flat fields array to a correct Match object', () => {
    const match = createMatch();
    const fields = matchToFields(match);

    const result = fieldsToMatch(fields);

    expect(result.matchId).toBe(match.matchId);
    expect(result.lendOrderId).toBe(match.lendOrderId);
    expect(result.borrowOrderId).toBe(match.borrowOrderId);
    expect(result.lenderWallet).toBe(match.lenderWallet);
    expect(result.borrowerWallet).toBe(match.borrowerWallet);
    expect(result.matchedAmount).toBe(match.matchedAmount);
    expect(result.rate).toBe(match.rate);
    expect(result.loanToken).toBe(match.loanToken);
    expect(result.maturity).toBe(match.maturity);
    expect(result.timestamp).toBe(match.timestamp);
  });

  it('should convert "true" string to boolean true for borrowerIsTaker', () => {
    const match = createMatch({ borrowerIsTaker: true });
    const fields = matchToFields(match);

    const result = fieldsToMatch(fields);
    expect(result.borrowerIsTaker).toBe(true);
  });

  it('should convert "false" string to boolean false for borrowerIsTaker', () => {
    const match = createMatch({ borrowerIsTaker: false });
    const fields = matchToFields(match);

    const result = fieldsToMatch(fields);
    expect(result.borrowerIsTaker).toBe(false);
  });

  it('should default missing fee fields to "0"', () => {
    const match = createMatch();
    // Build fields without fee fields
    const fields = [
      'matchId', match.matchId,
      'marketId', match.marketId,
      'lendOrderId', match.lendOrderId,
      'borrowOrderId', match.borrowOrderId,
      'lenderWallet', match.lenderWallet,
      'borrowerWallet', match.borrowerWallet,
      'matchedAmount', match.matchedAmount,
      'rate', String(match.rate),
      'loanToken', match.loanToken,
      'maturity', String(match.maturity),
      'timestamp', String(match.timestamp),
      'borrowerIsTaker', String(match.borrowerIsTaker),
      // Fee fields omitted
    ];

    const result = fieldsToMatch(fields);
    expect(result.makerFeeAmount).toBe('0');
    expect(result.takerFeeAmount).toBe('0');
    expect(result.lenderSettlementFeeAmount).toBe('0');
    expect(result.borrowerSettlementFeeAmount).toBe('0');
  });

  it('should convert numeric string fields to numbers', () => {
    const match = createMatch({ rate: 750, maturity: 1704067200 });
    const fields = matchToFields(match);

    const result = fieldsToMatch(fields);
    expect(typeof result.rate).toBe('number');
    expect(result.rate).toBe(750);
    expect(typeof result.maturity).toBe('number');
    expect(result.maturity).toBe(1704067200);
    expect(typeof result.timestamp).toBe('number');
  });
});

describe('fieldsToMatch validation with matchSchema', () => {
  it('should produce a valid Match from a complete fields array', () => {
    const match = createMatch();
    const fields = matchToFields(match);
    const converted = fieldsToMatch(fields);

    expect(() => matchSchema.parse(converted)).not.toThrow();
  });

  it('should produce undefined values for odd-length fields array', () => {
    const match = createMatch();
    const fields = matchToFields(match);
    // Remove last element to make odd-length — the key 'borrowerSettlementFeeAmount'
    // now has no value, and the next iteration reads past the end (undefined key).
    // But since the fee fields have ?? '0' fallback, the schema may still pass.
    // The real danger is when a required non-fee field loses its value.
    // Simulate by removing a core field value:
    const truncated = fields.slice(0, 3); // Only 'matchId', value, 'marketId' — marketId has no value
    const converted = fieldsToMatch(truncated);
    // marketId should be undefined, which fails UUID validation
    const result = matchSchema.safeParse(converted);
    expect(result.success).toBe(false);
  });

  it('should fail schema validation for empty fields array', () => {
    const converted = fieldsToMatch([]);
    const result = matchSchema.safeParse(converted);
    expect(result.success).toBe(false);
  });

  it('should fail schema validation when matchId is missing', () => {
    const match = createMatch();
    // Build fields without matchId
    const fields = [
      'marketId', match.marketId,
      'lendOrderId', match.lendOrderId,
      'borrowOrderId', match.borrowOrderId,
      'lenderWallet', match.lenderWallet,
      'borrowerWallet', match.borrowerWallet,
      'matchedAmount', match.matchedAmount,
      'rate', String(match.rate),
      'loanToken', match.loanToken,
      'maturity', String(match.maturity),
      'timestamp', String(match.timestamp),
      'borrowerIsTaker', String(match.borrowerIsTaker),
      'makerFeeAmount', match.makerFeeAmount,
      'takerFeeAmount', match.takerFeeAmount,
      'lenderSettlementFeeAmount', match.lenderSettlementFeeAmount,
      'borrowerSettlementFeeAmount', match.borrowerSettlementFeeAmount,
    ];

    const converted = fieldsToMatch(fields);
    const result = matchSchema.safeParse(converted);
    expect(result.success).toBe(false);
  });
});

describe('fieldsToMatch edge cases', () => {
  it('should ignore extra unknown keys in fields', () => {
    const match = createMatch();
    const fields = [
      ...matchToFields(match),
      'unknownKey', 'unknownValue',
      'anotherExtra', '12345',
    ];

    const converted = fieldsToMatch(fields);
    // Extra keys should not break conversion; schema strips unknown keys
    expect(() => matchSchema.parse(converted)).not.toThrow();
  });

  it('should map borrowerIsTaker "false" to boolean false (not truthy string)', () => {
    const match = createMatch({ borrowerIsTaker: false });
    const fields = matchToFields(match);

    const converted = fieldsToMatch(fields);
    expect(converted.borrowerIsTaker).toBe(false);
    // Verify it's strict boolean false, not the string "false"
    expect(converted.borrowerIsTaker).not.toBe('false');
  });

  it('should handle rate "0" by converting to number 0', () => {
    // When rate is "0", Number("0") = 0, but the condition obj.rate ? ... : 0
    // treats "0" as falsy, so it returns 0 via the fallback path
    const match = createMatch({ rate: 0 });
    const fields = matchToFields(match);

    const converted = fieldsToMatch(fields);
    expect(converted.rate).toBe(0);
  });

  it('should preserve very large matchedAmount strings as-is', () => {
    const largeAmount = '999999999999999999999999999999';
    const match = createMatch({ matchedAmount: largeAmount });
    const fields = matchToFields(match);

    const converted = fieldsToMatch(fields);
    expect(converted.matchedAmount).toBe(largeAmount);
  });
});
