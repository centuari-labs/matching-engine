/**
 * DbWriterService Unit Tests
 *
 * Tests for DbWriterService with fully mocked NATS, Redis, and DbClient dependencies.
 */

import { DbWriterService } from '../services/db-writer-service';
import { NATS_TOPICS } from '../config/nats-config';
import { REDIS_CONSUMER_GROUPS, REDIS_STREAMS } from '../config/redis-config';
import { createMatch } from './factories/match-factory';

import type { DbClient } from '../types/db';

// Create mock NATS subscription
function createMockSubscription() {
  const messages: Uint8Array[] = [];
  let resolve: (() => void) | null = null;

  const sub = {
    drain: jest.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: jest.fn().mockImplementation(() => {
      return {
        next: jest.fn().mockImplementation(async () => {
          if (messages.length > 0) {
            return { done: false, value: { data: messages.shift() } };
          }
          // Block until cancelled
          return new Promise<{ done: boolean; value: undefined }>((res) => {
            resolve = () => res({ done: true, value: undefined });
          });
        }),
        return: jest.fn().mockResolvedValue({ done: true, value: undefined }),
      };
    }),
    _push(data: Uint8Array) {
      messages.push(data);
    },
    _close() {
      if (resolve) resolve();
    },
  };

  return sub;
}

function createMockNatsConnection() {
  const subscriptions: ReturnType<typeof createMockSubscription>[] = [];

  return {
    subscribe: jest.fn().mockImplementation(() => {
      const sub = createMockSubscription();
      subscriptions.push(sub);
      return sub;
    }),
    publish: jest.fn(),
    drain: jest.fn().mockResolvedValue(undefined),
    closed: jest.fn().mockReturnValue(new Promise(() => {})),
    _subscriptions: subscriptions,
  };
}

function createMockRedis() {
  return {
    xgroup: jest.fn().mockResolvedValue('OK'),
    xreadgroup: jest.fn().mockResolvedValue(null),
    xack: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
  };
}

function createMockDbClient(): jest.Mocked<DbClient> {
  return {
    updateOrderStatus: jest.fn().mockResolvedValue(undefined),
    insertMatch: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('DbWriterService', () => {
  let mockNc: ReturnType<typeof createMockNatsConnection>;
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockDbClient: jest.Mocked<DbClient>;
  let service: DbWriterService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNc = createMockNatsConnection();
    mockRedis = createMockRedis();
    mockDbClient = createMockDbClient();
  });

  afterEach(async () => {
    if (service) {
      try {
        await service.stop();
      } catch {
        // ignore
      }
    }
  });

  describe('constructor', () => {
    it('should accept default options', () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      expect(service).toBeDefined();
    });

    it('should accept custom options', () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient, {
        maxConcurrency: 5,
        redisConsumerGroup: 'custom-group',
        redisConsumerName: 'custom-consumer',
        redisBlockTimeoutMs: 2000,
        redisBatchSize: 25,
      });
      expect(service).toBeDefined();
    });
  });

  describe('start', () => {
    it('should subscribe to NATS orders.status topic', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      expect(mockNc.subscribe).toHaveBeenCalledWith(NATS_TOPICS.ORDERS_STATUS);
    });

    it('should create Redis consumer group', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      expect(mockRedis.xgroup).toHaveBeenCalledWith(
        'CREATE',
        REDIS_STREAMS.SETTLEMENT_MATCHES,
        REDIS_CONSUMER_GROUPS.DB_WRITER,
        '0',
        'MKSTREAM'
      );
    });

    it('should handle existing Redis consumer group (BUSYGROUP)', async () => {
      mockRedis.xgroup.mockRejectedValueOnce(
        new Error('BUSYGROUP Consumer Group name already exists')
      );

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      const logCalls = consoleSpy.mock.calls.flat();
      expect(
        logCalls.some((msg) => typeof msg === 'string' && msg.includes('already exists'))
      ).toBe(true);
      consoleSpy.mockRestore();
    });
  });

  describe('stop', () => {
    it('should drain NATS subscription and close DB client', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();
      await service.stop();

      expect(mockDbClient.close).toHaveBeenCalled();
    });
  });

  describe('handleOrderStatusMessage (via NATS)', () => {
    it('should parse valid order status message and update DB', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      const message = {
        orderId: '123e4567-e89b-12d3-a456-426614174000',
        status: 'PARTIALLY_FILLED',
        remainingAmount: '500000',
        quantity: '1000000',
        filledQuantity: '500000',
        settlementFeeAmount: '10000',
        filledSettlementFeeAmount: '5000',
        timestamp: Date.now(),
      };

      // Call private method directly
      await (service as any).handleOrderStatusMessage(
        new TextEncoder().encode(JSON.stringify(message))
      );

      expect(mockDbClient.updateOrderStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: message.orderId,
          status: 'PARTIALLY_FILLED',
          remainingAmount: '500000',
        })
      );
    });

    it('should handle invalid JSON gracefully', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await (service as any).handleOrderStatusMessage(new TextEncoder().encode('not-valid-json'));

      expect(consoleSpy).toHaveBeenCalled();
      const hadParseError = consoleSpy.mock.calls.some((call) =>
        call.some(
          (arg) => typeof arg === 'string' && arg.includes('failed to parse order status JSON')
        )
      );
      expect(hadParseError).toBe(true);
      expect(mockDbClient.updateOrderStatus).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle invalid schema gracefully', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      // Valid JSON but missing required fields
      await (service as any).handleOrderStatusMessage(
        new TextEncoder().encode(JSON.stringify({ foo: 'bar' }))
      );

      expect(consoleSpy).toHaveBeenCalled();
      expect(mockDbClient.updateOrderStatus).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle DB error gracefully', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      mockDbClient.updateOrderStatus.mockRejectedValueOnce(new Error('DB connection lost'));

      const message = {
        orderId: '123e4567-e89b-12d3-a456-426614174000',
        status: 'FILLED',
        remainingAmount: '0',
        timestamp: Date.now(),
      };

      await expect(
        (service as any).handleOrderStatusMessage(new TextEncoder().encode(JSON.stringify(message)))
      ).rejects.toThrow('DB connection lost');
    });
  });

  describe('handleRedisEntry', () => {
    it('should parse valid match fields and insert into DB', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      const match = createMatch();
      const fields = [
        'matchId',
        match.matchId,
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

      await (service as any).handleRedisEntry('1-0', fields);

      expect(mockDbClient.insertMatch).toHaveBeenCalledWith(
        expect.objectContaining({
          matchId: match.matchId,
          matchedAmount: match.matchedAmount,
          rate: match.rate,
        })
      );

      expect(mockRedis.xack).toHaveBeenCalledWith(
        REDIS_STREAMS.SETTLEMENT_MATCHES,
        REDIS_CONSUMER_GROUPS.DB_WRITER,
        '1-0'
      );
    });

    it('should acknowledge and skip invalid match entries', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const badFields = [
        'matchId',
        '00000000-0000-0000-0000-000000000000',
        'lendOrderId',
        '00000000-0000-0000-0000-000000000001',
        // Missing many required fields
      ];

      await (service as any).handleRedisEntry('2-0', badFields);

      expect(mockDbClient.insertMatch).not.toHaveBeenCalled();
      // Should still acknowledge the bad entry
      expect(mockRedis.xack).toHaveBeenCalledWith(
        REDIS_STREAMS.SETTLEMENT_MATCHES,
        REDIS_CONSUMER_GROUPS.DB_WRITER,
        '2-0'
      );
      consoleSpy.mockRestore();
    });

    it('should handle DB insert error', async () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);
      await service.start();

      mockDbClient.insertMatch.mockRejectedValueOnce(new Error('constraint violation'));

      const match = createMatch();
      const fields = [
        'matchId',
        match.matchId,
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

      await expect((service as any).handleRedisEntry('3-0', fields)).rejects.toThrow(
        'constraint violation'
      );
    });
  });

  describe('fieldsToMatch', () => {
    it('should convert flat field array to Match-like object', () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);

      const result = (service as any).fieldsToMatch([
        'matchId',
        'test-id',
        'rate',
        '500',
        'borrowerIsTaker',
        'true',
        'maturity',
        '1704067200',
        'timestamp',
        '1704067200000',
        'matchedAmount',
        '1000000',
        'makerFeeAmount',
        '1000',
        'takerFeeAmount',
        '2000',
        'lenderSettlementFeeAmount',
        '5000',
        'borrowerSettlementFeeAmount',
        '5000',
      ]);

      expect(result.matchId).toBe('test-id');
      expect(result.rate).toBe(500);
      expect(result.borrowerIsTaker).toBe(true);
      expect(result.maturity).toBe(1704067200);
      expect(result.timestamp).toBe(1704067200000);
    });

    it('should use defaults for missing fields', () => {
      service = new DbWriterService(mockNc as any, mockRedis as any, mockDbClient);

      const result = (service as any).fieldsToMatch([]);

      expect(result.rate).toBe(0);
      expect(result.maturity).toBe(0);
      expect(result.timestamp).toBe(0);
      expect(result.borrowerIsTaker).toBe(false);
      expect(result.makerFeeAmount).toBe('0');
      expect(result.takerFeeAmount).toBe('0');
      expect(result.lenderSettlementFeeAmount).toBe('0');
      expect(result.borrowerSettlementFeeAmount).toBe('0');
    });
  });
});
