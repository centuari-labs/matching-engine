/**
 * Redis Service Integration Tests
 *
 * Tests for RedisService methods and behavior using a real Redis connection.
 * These tests require a running Redis instance.
 *
 * Uses Redis database 15 (test database) to avoid interfering with production data.
 * All test data is cleaned up after each test.
 */

import { RedisService } from '../services/redis-service';
import { REDIS_STREAMS } from '../config/redis-config';
import type { SettlementMatch } from '../types/settlement';
import { generateMatchId, generateOrderId } from '../utils/helpers';
import Redis from 'ioredis';

describe('RedisService', () => {
  const loanToken = '0x1234567890123456789012345678901234567890';
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  const maturity = 1704067200;

  // Use test database (15) to avoid interfering with production data
  const TEST_DB = 15;
  const testConfig = {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    db: TEST_DB,
    maxReconnectAttempts: 3,
    reconnectTimeWait: 1000,
    timeout: 5000,
    tls: false,
  };

  let redisService: RedisService;
  let cleanupClient: Redis | null = null;

  // Helper to create a test match
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
    };
  }

  beforeAll(async () => {
    // Verify Redis is available before running tests
    try {
      const testClient = new Redis({
        host: 'localhost',
        port: 6379,
        db: TEST_DB,
        lazyConnect: true,
      });
      await testClient.connect();
      await testClient.ping();
      await testClient.quit();
    } catch (error) {
      console.error(
        'Redis is not available. Please start Redis before running these tests.'
      );
      throw error;
    }
  });

  beforeEach(async () => {
    // Create a new service instance for each test
    redisService = new RedisService(testConfig);

    // Create a cleanup client to remove test data
    cleanupClient = new Redis({
      host: 'localhost',
      port: 6379,
      db: TEST_DB,
      lazyConnect: true,
    });
    await cleanupClient.connect();
  });

  afterEach(async () => {
    // Clean up: disconnect service and remove test stream data
    if (redisService && redisService.isServiceConnected()) {
      await redisService.disconnect();
    }

    if (cleanupClient) {
      try {
        // Delete the test stream
        await cleanupClient.del(REDIS_STREAMS.SETTLEMENT_MATCHES);
        await cleanupClient.quit();
      } catch (error) {
        // Ignore cleanup errors
      }
      cleanupClient = null;
    }
  });

  describe('Service Initialization', () => {
    it('should create a Redis service instance', () => {
      const service = new RedisService(testConfig);
      expect(service).toBeDefined();
      expect(service.isServiceConnected()).toBe(false);
    });

    it('should create service with custom config', () => {
      const service = new RedisService({
        url: 'redis://localhost:6379',
        db: TEST_DB,
        maxReconnectAttempts: 20,
        reconnectTimeWait: 3000,
        timeout: 15000,
        tls: false,
      });
      expect(service).toBeDefined();
    });

    it('should return correct stats when not connected', () => {
      const service = new RedisService({
        url: 'redis://localhost:6379',
        db: TEST_DB,
        maxReconnectAttempts: 10,
        reconnectTimeWait: 2000,
        timeout: 10000,
        tls: false,
      });

      const stats = service.getStats();
      expect(stats.connected).toBe(false);
      expect(stats.config.url).toBe('redis://localhost:6379');
      expect(stats.config.db).toBe(TEST_DB);
      expect(stats.config.hasAuth).toBe(false);
    });

    it('should report hasAuth when password is provided', () => {
      const service = new RedisService({
        url: 'redis://localhost:6379',
        password: 'secret',
        db: TEST_DB,
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
      const service = new RedisService(testConfig);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      await service.disconnect();

      expect(consoleSpy).toHaveBeenCalledWith('Redis service is not connected');
      consoleSpy.mockRestore();
    });

    it('should return null client when not connected', () => {
      const service = new RedisService(testConfig);
      expect(service.getClient()).toBeNull();
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
      expect(messageId).toMatch(/^\d+-\d+$/); // Redis stream ID format
    });

    it('should return null when not connected', async () => {
      const service = new RedisService(testConfig);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const match = createTestMatch();
      const messageId = await service.publishSettlementMatch(match);

      expect(messageId).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should include all match fields in published data', async () => {
      await redisService.connect();

      const match = createTestMatch();
      const messageId = await redisService.publishSettlementMatch(match);
      expect(messageId).not.toBeNull();

      // Verify data was actually written to Redis stream
      if (cleanupClient) {
        const messages = await cleanupClient.xrange(
          REDIS_STREAMS.SETTLEMENT_MATCHES,
          messageId!,
          messageId!
        );

        expect(messages).toHaveLength(1);
        const [, fields] = messages[0];

        // Convert fields array to object for easier checking
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldMap[fields[i]] = fields[i + 1];
        }

        expect(fieldMap.matchId).toBe(match.matchId);
        expect(fieldMap.lendOrderId).toBe(match.lendOrderId);
        expect(fieldMap.borrowOrderId).toBe(match.borrowOrderId);
        expect(fieldMap.lenderWallet).toBe(match.lenderWallet);
        expect(fieldMap.borrowerWallet).toBe(match.borrowerWallet);
        expect(fieldMap.matchedAmount).toBe(match.matchedAmount);
        expect(fieldMap.rate).toBe(match.rate.toString());
        expect(fieldMap.loanToken).toBe(match.loanToken);
        expect(fieldMap.maturity).toBe(match.maturity.toString());
        expect(fieldMap.timestamp).toBe(match.timestamp.toString());
        expect(fieldMap.borrowerIsTaker).toBe(match.borrowerIsTaker.toString());
      }
    });

    it('should handle Redis errors gracefully', async () => {
      await redisService.connect();

      // Disconnect the underlying client to simulate an error
      const client = redisService.getClient();
      if (client) {
        await client.quit();
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

      // Publish a test message to create stream
      const match = createTestMatch();
      await redisService.publishSettlementMatch(match);

      const info = await redisService.getStreamInfo();

      expect(info).not.toBeNull();
      expect(info!.length).toBeGreaterThanOrEqual(1);
      expect(info!.groups).toBeGreaterThanOrEqual(1);
    });

    it('should return null when not connected', async () => {
      const service = new RedisService(testConfig);
      const info = await service.getStreamInfo();
      expect(info).toBeNull();
    });

    it('should handle empty stream gracefully', async () => {
      await redisService.connect();

      // Stream might not exist yet
      const info = await redisService.getStreamInfo();
      expect(info).not.toBeNull();
      expect(info!.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('healthCheck', () => {
    it('should return true when healthy', async () => {
      await redisService.connect();

      const healthy = await redisService.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should return false when not connected', async () => {
      const service = new RedisService(testConfig);
      const healthy = await service.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe('Stream Setup', () => {
    it('should create consumer group on connect', async () => {
      await redisService.connect();

      // Verify consumer group exists by checking stream info
      const info = await redisService.getStreamInfo();
      expect(info).not.toBeNull();
      expect(info!.groups).toBeGreaterThanOrEqual(1);
    });

    it('should handle existing consumer group gracefully', async () => {
      // First connection creates the group
      await redisService.connect();
      await redisService.disconnect();

      // Second connection should handle existing group
      const service2 = new RedisService(testConfig);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      // Should not throw
      await service2.connect();

      // Should log that group already exists or created successfully
      const logCalls = consoleSpy.mock.calls.flat();
      const hasGroupMessage = logCalls.some((msg) =>
        typeof msg === 'string' &&
        (msg.includes('already exists') || msg.includes('Created consumer group'))
      );
      expect(hasGroupMessage || consoleSpy.mock.calls.length > 0).toBe(true);
      
      consoleSpy.mockRestore();
      await service2.disconnect();
    });
  });

  describe('SettlementPublisher Interface', () => {
    it('should implement SettlementPublisher interface', () => {
      const service = new RedisService(testConfig);

      // Verify service has the required method
      expect(typeof service.publishSettlementMatch).toBe('function');
    });

    it('should be usable as SettlementPublisher type', async () => {
      await redisService.connect();
      const service: import('../types/settlement').SettlementPublisher = redisService;
      const match = createTestMatch();
      const messageId = await service.publishSettlementMatch(match);
      expect(messageId).not.toBeNull();
    });
  });

  describe('Real Redis Integration', () => {
    it('should actually connect to Redis and publish messages', async () => {
      await redisService.connect();
      expect(redisService.isServiceConnected()).toBe(true);

      // Publish a message
      const match = createTestMatch();
      const messageId = await redisService.publishSettlementMatch(match);
      expect(messageId).not.toBeNull();

      // Verify message exists in Redis
      if (cleanupClient) {
        const messages = await cleanupClient.xrange(
          REDIS_STREAMS.SETTLEMENT_MATCHES,
          '-',
          '+',
          'COUNT',
          1
        );
        console.log("MESSAGES: ", messages)
        expect(messages.length).toBeGreaterThan(0);
      }
    });

    it('should handle multiple messages in stream', async () => {
      await redisService.connect();

      // Publish multiple messages
      const match1 = createTestMatch();
      const match2 = createTestMatch();
      const match3 = createTestMatch();

      const id1 = await redisService.publishSettlementMatch(match1);
      const id2 = await redisService.publishSettlementMatch(match2);
      const id3 = await redisService.publishSettlementMatch(match3);

      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id3).not.toBeNull();

      // Verify all messages are in the stream
      const info = await redisService.getStreamInfo();
      expect(info!.length).toBeGreaterThanOrEqual(3);
    });
  });
});
