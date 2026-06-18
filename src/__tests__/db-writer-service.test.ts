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
const REDIS_MATCH_FIELD_KEYS = new Set([
  'matchId',
  'marketId',
  'lendOrderId',
  'borrowOrderId',
  'lenderWallet',
  'borrowerWallet',
  'matchedAmount',
  'rate',
  'loanToken',
  'maturity',
  'timestamp',
  'borrowerIsTaker',
  'makerFeeAmount',
  'takerFeeAmount',
  'lenderSettlementFeeAmount',
  'borrowerSettlementFeeAmount',
  'borrowerCollateralAssets',
]);

function fieldsToMatch(fields: string[]): Record<string, unknown> {
  const obj: Record<string, string> = Object.create(null);
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];

    if (!key || value === undefined || !REDIS_MATCH_FIELD_KEYS.has(key)) {
      continue;
    }

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
    borrowerCollateralAssets: obj.borrowerCollateralAssets
      ? (() => {
          try {
            const parsed = JSON.parse(obj.borrowerCollateralAssets);
            return Array.isArray(parsed)
              ? parsed.filter((v: unknown): v is string => typeof v === 'string')
              : [];
          } catch {
            return [];
          }
        })()
      : [],
  };
}

/**
 * Helper: convert a Match object to a flat Redis fields array (key-value pairs).
 */
function matchToFields(match: ReturnType<typeof createMatch>): string[] {
  return [
    'matchId',
    match.matchId,
    'marketId',
    match.marketId,
    'lendOrderId',
    match.lendOrderId,
    'borrowOrderId',
    match.borrowOrderId,
    'lenderWallet',
    match.lenderWallet,
    'borrowerWallet',
    match.borrowerWallet,
    'matchedAmount',
    match.matchedAmount,
    'rate',
    String(match.rate),
    'loanToken',
    match.loanToken,
    'maturity',
    String(match.maturity),
    'timestamp',
    String(match.timestamp),
    'borrowerIsTaker',
    String(match.borrowerIsTaker),
    'makerFeeAmount',
    match.makerFeeAmount,
    'takerFeeAmount',
    match.takerFeeAmount,
    'lenderSettlementFeeAmount',
    match.lenderSettlementFeeAmount,
    'borrowerSettlementFeeAmount',
    match.borrowerSettlementFeeAmount,
    'borrowerCollateralAssets',
    JSON.stringify(match.borrowerCollateralAssets),
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

  it('should ignore dangerous Redis field names', () => {
    const match = createMatch();
    const fields = ['__proto__', '{"polluted":true}', ...matchToFields(match)];

    const result = fieldsToMatch(fields);

    expect(result.matchId).toBe(match.matchId);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('should default missing fee fields to "0"', () => {
    const match = createMatch();
    // Build fields without fee fields
    const fields = [
      'matchId',
      match.matchId,
      'marketId',
      match.marketId,
      'lendOrderId',
      match.lendOrderId,
      'borrowOrderId',
      match.borrowOrderId,
      'lenderWallet',
      match.lenderWallet,
      'borrowerWallet',
      match.borrowerWallet,
      'matchedAmount',
      match.matchedAmount,
      'rate',
      String(match.rate),
      'loanToken',
      match.loanToken,
      'maturity',
      String(match.maturity),
      'timestamp',
      String(match.timestamp),
      'borrowerIsTaker',
      String(match.borrowerIsTaker),
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
      'marketId',
      match.marketId,
      'lendOrderId',
      match.lendOrderId,
      'borrowOrderId',
      match.borrowOrderId,
      'lenderWallet',
      match.lenderWallet,
      'borrowerWallet',
      match.borrowerWallet,
      'matchedAmount',
      match.matchedAmount,
      'rate',
      String(match.rate),
      'loanToken',
      match.loanToken,
      'maturity',
      String(match.maturity),
      'timestamp',
      String(match.timestamp),
      'borrowerIsTaker',
      String(match.borrowerIsTaker),
      'makerFeeAmount',
      match.makerFeeAmount,
      'takerFeeAmount',
      match.takerFeeAmount,
      'lenderSettlementFeeAmount',
      match.lenderSettlementFeeAmount,
      'borrowerSettlementFeeAmount',
      match.borrowerSettlementFeeAmount,
    ];

    const converted = fieldsToMatch(fields);
    const result = matchSchema.safeParse(converted);
    expect(result.success).toBe(false);
  });
});

describe('fieldsToMatch edge cases', () => {
  it('should ignore extra unknown keys in fields', () => {
    const match = createMatch();
    const fields = [...matchToFields(match), 'unknownKey', 'unknownValue', 'anotherExtra', '12345'];

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

/**
 * Tests for DbWriterService.handleOrderUpdatedMessage() logic.
 *
 * Verifies that order update messages are parsed, validated, and delegated
 * to the DbClient without requiring real connections.
 */
describe('handleOrderUpdatedMessage', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DbWriterService } = require('../services/db-writer-service');

  function createMockNats() {
    return {
      subscribe: jest.fn(() => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        drain: jest.fn(),
      })),
    };
  }

  function createMockRedis() {
    return {
      xack: jest.fn().mockResolvedValue(1),
      xgroup: jest.fn().mockResolvedValue('OK'),
      xreadgroup: jest.fn().mockResolvedValue(null),
      xautoclaim: jest.fn().mockResolvedValue(['0-0', [], []]),
    };
  }

  function createMockDbClient() {
    return {
      updateOrderStatus: jest.fn().mockResolvedValue(undefined),
      insertMatch: jest.fn().mockResolvedValue(undefined),
      insertCancelledOrder: jest.fn().mockResolvedValue(undefined),
      updateOrderParameters: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
  }

  function getHandler(service: InstanceType<typeof DbWriterService>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (service as any).handleOrderUpdatedMessage.bind(service);
  }

  function toBytes(obj: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  it('should call dbClient.updateOrderParameters with valid data', async () => {
    const dbClient = createMockDbClient();
    const service = new DbWriterService(createMockNats(), createMockRedis(), dbClient);
    const handle = getHandler(service);

    const orderId = '550e8400-e29b-41d4-a716-446655440000';
    const event = {
      orderId,
      originalAmount: '2000000',
      remainingAmount: '1000000',
      rate: 500,
      settlementFeeAmount: '20000',
      remainingSettlementFeeAmount: '10000',
      timestamp: Date.now(),
    };

    await handle(toBytes(event));

    expect(dbClient.updateOrderParameters).toHaveBeenCalledTimes(1);
    expect(dbClient.updateOrderParameters).toHaveBeenCalledWith(
      expect.objectContaining({ orderId, originalAmount: '2000000', rate: 500 })
    );
  });

  it('should NOT call dbClient for invalid JSON', async () => {
    const dbClient = createMockDbClient();
    const service = new DbWriterService(createMockNats(), createMockRedis(), dbClient);
    const handle = getHandler(service);

    await handle(new Uint8Array([0xff, 0xfe]));

    expect(dbClient.updateOrderParameters).not.toHaveBeenCalled();
  });

  it('should NOT call dbClient for schema-invalid data', async () => {
    const dbClient = createMockDbClient();
    const service = new DbWriterService(createMockNats(), createMockRedis(), dbClient);
    const handle = getHandler(service);

    await handle(
      toBytes({
        orderId: 'not-a-uuid',
        originalAmount: '2000000',
        // Missing required fields
      })
    );

    expect(dbClient.updateOrderParameters).not.toHaveBeenCalled();
  });
});

/**
 * Tests for DbWriterService.handleRedisEntry() retry logic.
 *
 * Uses a minimal DbWriterService instantiation with mock NATS, Redis, and
 * DbClient to verify that transient DB failures are retried and that entries
 * are only ACK'd after successful persistence.
 */
describe('handleRedisEntry retry logic', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DbWriterService } = require('../services/db-writer-service');

  function createMockNats() {
    return {
      subscribe: jest.fn(() => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        drain: jest.fn(),
      })),
    };
  }

  function createMockRedis() {
    return {
      xack: jest.fn().mockResolvedValue(1),
      xgroup: jest.fn().mockResolvedValue('OK'),
      xreadgroup: jest.fn().mockResolvedValue(null),
      xautoclaim: jest.fn().mockResolvedValue(['0-0', [], []]),
    };
  }

  function createMockDbClient(insertMatchImpl?: () => Promise<void>) {
    return {
      updateOrderStatus: jest.fn().mockResolvedValue(undefined),
      insertMatch: insertMatchImpl
        ? jest.fn(insertMatchImpl)
        : jest.fn().mockResolvedValue(undefined),
      insertCancelledOrder: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
  }

  function buildFields(match: ReturnType<typeof createMatch>): string[] {
    return [
      'matchId',
      match.matchId,
      'marketId',
      match.marketId,
      'lendOrderId',
      match.lendOrderId,
      'borrowOrderId',
      match.borrowOrderId,
      'lenderWallet',
      match.lenderWallet,
      'borrowerWallet',
      match.borrowerWallet,
      'matchedAmount',
      match.matchedAmount,
      'rate',
      String(match.rate),
      'loanToken',
      match.loanToken,
      'maturity',
      String(match.maturity),
      'timestamp',
      String(match.timestamp),
      'borrowerIsTaker',
      String(match.borrowerIsTaker),
      'makerFeeAmount',
      match.makerFeeAmount,
      'takerFeeAmount',
      match.takerFeeAmount,
      'lenderSettlementFeeAmount',
      match.lenderSettlementFeeAmount,
      'borrowerSettlementFeeAmount',
      match.borrowerSettlementFeeAmount,
    ];
  }

  /**
   * Access the private handleRedisEntry method for direct testing.
   */
  function getHandler(service: InstanceType<typeof DbWriterService>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (service as any).handleRedisEntry.bind(service);
  }

  it('should ACK after successful insert on first attempt', async () => {
    const redis = createMockRedis();
    const dbClient = createMockDbClient();
    const service = new DbWriterService(createMockNats(), redis, dbClient, { maxInsertRetries: 3 });

    const match = createMatch();
    const handle = getHandler(service);
    await handle('entry-1', buildFields(match));

    expect(dbClient.insertMatch).toHaveBeenCalledTimes(1);
    expect(redis.xack).toHaveBeenCalledTimes(1);
  });

  it('should retry and succeed on transient failure then ACK', async () => {
    let callCount = 0;
    const dbClient = createMockDbClient(async () => {
      callCount++;
      if (callCount < 3) throw new Error('transient DB error');
    });
    const redis = createMockRedis();
    const service = new DbWriterService(createMockNats(), redis, dbClient, { maxInsertRetries: 3 });

    const match = createMatch();
    const handle = getHandler(service);
    await handle('entry-2', buildFields(match));

    expect(dbClient.insertMatch).toHaveBeenCalledTimes(3);
    expect(redis.xack).toHaveBeenCalledTimes(1);
  });

  it('should NOT ACK after exhausting all retries', async () => {
    const dbClient = createMockDbClient(async () => {
      throw new Error('persistent DB error');
    });
    const redis = createMockRedis();
    const service = new DbWriterService(createMockNats(), redis, dbClient, { maxInsertRetries: 3 });

    const match = createMatch();
    const handle = getHandler(service);

    await expect(handle('entry-3', buildFields(match))).rejects.toThrow('persistent DB error');

    expect(dbClient.insertMatch).toHaveBeenCalledTimes(3);
    expect(redis.xack).not.toHaveBeenCalled();
  });

  it('should ACK invalid entries without attempting insert', async () => {
    const dbClient = createMockDbClient();
    const redis = createMockRedis();
    const service = new DbWriterService(createMockNats(), redis, dbClient, { maxInsertRetries: 3 });

    const handle = getHandler(service);
    // Empty fields produce an invalid match
    await handle('entry-4', []);

    expect(dbClient.insertMatch).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledTimes(1);
  });
});
