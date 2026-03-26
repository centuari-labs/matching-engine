/**
 * Redis Service Unit Tests
 *
 * Tests for RedisService using mocked ioredis to avoid requiring a running Redis instance.
 */

import { RedisService } from '../services/redis-service';
import { REDIS_STREAMS, REDIS_CONSUMER_GROUPS } from '../config/redis-config';
import type { SettlementMatch } from '../types/settlement';
import { generateMatchId, generateOrderId } from '../utils/helpers';

// Mock ioredis
jest.mock('ioredis', () => {
  const mockRedisInstance = {
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    xadd: jest.fn().mockResolvedValue('1234567890-0'),
    xgroup: jest.fn().mockResolvedValue('OK'),
    xlen: jest.fn().mockResolvedValue(5),
    xinfo: jest.fn().mockResolvedValue([['name', 'settlement-engine']]),
    ping: jest.fn().mockResolvedValue('PONG'),
  };

  return jest.fn(() => mockRedisInstance);
});

describe('RedisService', () => {
  const loanToken = '0x1234567890123456789012345678901234567890';
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  const maturity = 1704067200;

  const testConfig = {
    url: 'redis://localhost:6379',
    db: 15,
    maxReconnectAttempts: 3,
    reconnectTimeWait: 1000,
    timeout: 5000,
    tls: false,
  };

  let redisService: RedisService;

  function createTestMatch(): SettlementMatch {
    return {
      matchId: generateMatchId(),
      lendOrderId: generateOrderId(),
      borrowOrderId: generateOrderId(),
      lenderWallet: walletAddress1,
      borrowerWallet: walletAddress2,
      matchedAmount: '1000000',
      rate: 500,
      loanToken,
      maturity,
      timestamp: Date.now(),
      borrowerIsTaker: true,
      makerFeeAmount: '1000',
      takerFeeAmount: '2000',
      lenderSettlementFeeAmount: '5000',
      borrowerSettlementFeeAmount: '5000',
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    redisService = new RedisService(testConfig);
  });

  afterEach(async () => {
    if (redisService && redisService.isServiceConnected()) {
      await redisService.disconnect();
    }
  });

  describe('Service Initialization', () => {
    it('should create a Redis service instance', () => {
      expect(redisService).toBeDefined();
      expect(redisService.isServiceConnected()).toBe(false);
    });

    it('should create service with custom config', () => {
      const service = new RedisService({
        url: 'redis://localhost:6379',
        db: 15,
        maxReconnectAttempts: 20,
        reconnectTimeWait: 3000,
        timeout: 15000,
        tls: false,
      });
      expect(service).toBeDefined();
    });

    it('should return correct stats when not connected', () => {
      const stats = redisService.getStats();
      expect(stats.connected).toBe(false);
      expect(stats.config.url).toBe('redis://localhost:6379');
      expect(stats.config.db).toBe(15);
      expect(stats.config.hasAuth).toBe(false);
    });

    it('should report hasAuth when password is provided', () => {
      const service = new RedisService({
        url: 'redis://localhost:6379',
        password: 'secret',
        db: 15,
        maxReconnectAttempts: 10,
        reconnectTimeWait: 2000,
        timeout: 10000,
        tls: false,
      });

      const stats = service.getStats();
      expect(stats.config.hasAuth).toBe(true);
    });
  });

  describe('Connection Management', () => {
    it('should connect to Redis', async () => {
      await redisService.connect();
      expect(redisService.isServiceConnected()).toBe(true);
    });

    it('should not connect twice', async () => {
      await redisService.connect();

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      await redisService.connect();

      expect(consoleSpy).toHaveBeenCalledWith('Redis service is already connected');
      consoleSpy.mockRestore();
    });

    it('should disconnect from Redis', async () => {
      await redisService.connect();
      expect(redisService.isServiceConnected()).toBe(true);

      await redisService.disconnect();
      expect(redisService.isServiceConnected()).toBe(false);
    });

    it('should handle disconnect when not connected', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      await redisService.disconnect();

      expect(consoleSpy).toHaveBeenCalledWith('Redis service is not connected');
      consoleSpy.mockRestore();
    });

    it('should return null client when not connected', () => {
      expect(redisService.getClient()).toBeNull();
    });

    it('should return client when connected', async () => {
      await redisService.connect();
      expect(redisService.getClient()).not.toBeNull();
    });
  });

  describe('publishSettlementMatch', () => {
    it('should publish match to Redis stream', async () => {
      await redisService.connect();

      const match = createTestMatch();
      const messageId = await redisService.publishSettlementMatch(match);

      expect(messageId).not.toBeNull();
      expect(messageId).toBe('1234567890-0');
    });

    it('should return null when not connected', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const match = createTestMatch();
      const messageId = await redisService.publishSettlementMatch(match);

      expect(messageId).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle Redis errors gracefully', async () => {
      await redisService.connect();

      const client = redisService.getClient();
      if (client) {
        (client.xadd as jest.Mock).mockRejectedValueOnce(new Error('Connection lost'));
      }

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const match = createTestMatch();
      const messageId = await redisService.publishSettlementMatch(match);

      expect(messageId).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('getStreamInfo', () => {
    it('should return stream info when connected', async () => {
      await redisService.connect();

      const info = await redisService.getStreamInfo();

      expect(info).not.toBeNull();
      expect(info!.length).toBe(5);
      expect(info!.groups).toBe(1);
    });

    it('should return null when not connected', async () => {
      const info = await redisService.getStreamInfo();
      expect(info).toBeNull();
    });

    it('should handle missing stream gracefully', async () => {
      await redisService.connect();

      const client = redisService.getClient();
      if (client) {
        (client.xlen as jest.Mock).mockRejectedValueOnce(new Error('no such key'));
      }

      const info = await redisService.getStreamInfo();
      expect(info).toEqual({ length: 0, groups: 0 });
    });
  });

  describe('healthCheck', () => {
    it('should return true when healthy', async () => {
      await redisService.connect();

      const healthy = await redisService.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should return false when not connected', async () => {
      const healthy = await redisService.healthCheck();
      expect(healthy).toBe(false);
    });

    it('should return false when ping fails', async () => {
      await redisService.connect();

      const client = redisService.getClient();
      if (client) {
        (client.ping as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
      }

      const healthy = await redisService.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe('Stream Setup', () => {
    it('should create consumer group on connect', async () => {
      await redisService.connect();

      const client = redisService.getClient();
      expect(client!.xgroup).toHaveBeenCalledWith(
        'CREATE',
        REDIS_STREAMS.SETTLEMENT_MATCHES,
        REDIS_CONSUMER_GROUPS.SETTLEMENT_ENGINE,
        '0',
        'MKSTREAM'
      );
    });

    it('should handle existing consumer group gracefully (BUSYGROUP)', async () => {
      const Redis = require('ioredis');
      const mockInstance = new Redis();
      (mockInstance.xgroup as jest.Mock).mockRejectedValueOnce(
        new Error('BUSYGROUP Consumer Group name already exists')
      );

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const service = new RedisService(testConfig);
      await service.connect();

      const logCalls = consoleSpy.mock.calls.flat();
      const hasGroupMessage = logCalls.some(
        (msg) => typeof msg === 'string' && msg.includes('already exists')
      );
      expect(hasGroupMessage).toBe(true);

      consoleSpy.mockRestore();
      await service.disconnect();
    });
  });

  describe('SettlementPublisher Interface', () => {
    it('should implement SettlementPublisher interface', () => {
      expect(typeof redisService.publishSettlementMatch).toBe('function');
    });

    it('should be usable as SettlementPublisher type', async () => {
      await redisService.connect();
      const service: import('../types/settlement').SettlementPublisher = redisService;
      const match = createTestMatch();
      const messageId = await service.publishSettlementMatch(match);
      expect(messageId).not.toBeNull();
    });
  });

  describe('TLS Configuration', () => {
    it('should accept TLS config', () => {
      const service = new RedisService({
        url: 'redis://localhost:6379',
        db: 0,
        maxReconnectAttempts: 3,
        reconnectTimeWait: 1000,
        timeout: 5000,
        tls: true,
      });
      expect(service).toBeDefined();
    });
  });
});
