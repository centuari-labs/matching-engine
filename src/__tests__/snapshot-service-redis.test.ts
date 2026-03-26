/**
 * Snapshot Service Redis Fallback Tests
 *
 * Tests for SnapshotService Redis-related functionality: saveToRedis, loadFromRedis,
 * and getSnapshotMetadata with Redis fallback.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SnapshotService } from '../services/snapshot-service';
import { OrderBook } from '../core/order-book';
import { ExecutionEngine } from '../core/execution-engine';
import type { RedisService } from '../services/redis-service';

function createMockRedisService(overrides: Partial<RedisService> = {}): RedisService {
  const mockClient = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };

  return {
    isServiceConnected: jest.fn().mockReturnValue(true),
    getClient: jest.fn().mockReturnValue(mockClient),
    connect: jest.fn(),
    disconnect: jest.fn(),
    publishSettlementMatch: jest.fn(),
    getStreamInfo: jest.fn(),
    healthCheck: jest.fn(),
    getStats: jest.fn(),
    ...overrides,
  } as unknown as RedisService;
}

describe('SnapshotService (Redis paths)', () => {
  const testSnapshotDir = path.join(__dirname, '../../test-snapshots-redis');
  let orderBook: OrderBook;
  let executionEngine: ExecutionEngine;

  async function cleanupSnapshotDir(): Promise<void> {
    try {
      await fs.rm(testSnapshotDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }

  beforeAll(async () => {
    await cleanupSnapshotDir();
  });

  afterAll(async () => {
    await cleanupSnapshotDir();
  });

  beforeEach(async () => {
    await cleanupSnapshotDir();
    orderBook = new OrderBook();
    executionEngine = new ExecutionEngine();
  });

  describe('saveSnapshot with Redis enabled', () => {
    it('should save to Redis when connected', async () => {
      const mockRedis = createMockRedisService();
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      await service.saveSnapshot(orderBook, executionEngine);

      // Wait a tick for the async Redis save
      await new Promise((r) => setTimeout(r, 50));

      const client = mockRedis.getClient();
      expect(client!.set).toHaveBeenCalledWith(
        'matching-engine:snapshot:latest',
        expect.any(String)
      );
      expect(client!.set).toHaveBeenCalledWith(
        'matching-engine:snapshot:metadata',
        expect.any(String)
      );
    });

    it('should not save to Redis when not connected', async () => {
      const mockRedis = createMockRedisService({
        isServiceConnected: jest.fn().mockReturnValue(false),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      await service.saveSnapshot(orderBook, executionEngine);

      await new Promise((r) => setTimeout(r, 50));

      const client = mockRedis.getClient();
      expect(client!.set).not.toHaveBeenCalled();
    });

    it('should not save to Redis when disabled', async () => {
      const mockRedis = createMockRedisService();
      const service = new SnapshotService(testSnapshotDir, mockRedis, false);

      await service.saveSnapshot(orderBook, executionEngine);

      await new Promise((r) => setTimeout(r, 50));

      const client = mockRedis.getClient();
      expect(client!.set).not.toHaveBeenCalled();
    });

    it('should handle Redis save failure gracefully', async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockRejectedValue(new Error('Redis write error')),
      };
      const mockRedis = createMockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Should not throw
      await service.saveSnapshot(orderBook, executionEngine);

      // Wait for async Redis save to fail
      await new Promise((r) => setTimeout(r, 100));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save snapshot to Redis'),
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });

    it('should handle backup rotation in Redis', async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue('{"existing":"backup"}'),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const mockRedis = createMockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      await service.saveSnapshot(orderBook, executionEngine);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockClient.get).toHaveBeenCalledWith('matching-engine:snapshot:backup');
    });
  });

  describe('loadSnapshot with Redis fallback', () => {
    it('should fall back to Redis when filesystem has no snapshot', async () => {
      const snapshotData = {
        version: '1.0.0',
        timestamp: Date.now(),
        orders: [],
        matches: [],
        metadata: { orderCount: 0, matchCount: 0 },
      };
      const mockClient = {
        get: jest.fn().mockResolvedValue(JSON.stringify(snapshotData)),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const mockRedis = createMockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      const result = await service.loadSnapshot();

      expect(result).not.toBeNull();
      expect(result!.version).toBe('1.0.0');
      expect(mockClient.get).toHaveBeenCalledWith('matching-engine:snapshot:latest');
    });

    it('should return null when Redis has no snapshot either', async () => {
      const mockClient = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const mockRedis = createMockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      const result = await service.loadSnapshot();
      expect(result).toBeNull();
    });

    it('should handle Redis fallback failure', async () => {
      const mockClient = {
        get: jest.fn().mockRejectedValue(new Error('Redis read error')),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const mockRedis = createMockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const result = await service.loadSnapshot();

      expect(result).toBeNull();
      consoleSpy.mockRestore();
    });

    it('should not try Redis when disabled', async () => {
      const mockRedis = createMockRedisService();
      const service = new SnapshotService(testSnapshotDir, mockRedis, false);

      const result = await service.loadSnapshot();
      expect(result).toBeNull();
      expect(mockRedis.getClient()!.get).not.toHaveBeenCalled();
    });

    it('should prefer filesystem over Redis', async () => {
      const mockRedis = createMockRedisService();
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      // Save a snapshot to filesystem first
      await service.saveSnapshot(orderBook, executionEngine);
      await new Promise((r) => setTimeout(r, 50));

      // Clear mock calls from saveSnapshot
      jest.clearAllMocks();
      (mockRedis.isServiceConnected as jest.Mock).mockReturnValue(true);

      const result = await service.loadSnapshot();
      expect(result).not.toBeNull();
      // Redis get for 'matching-engine:snapshot:latest' should not be called
      const getCalls = (mockRedis.getClient()!.get as jest.Mock).mock.calls;
      const latestCalls = getCalls.filter(
        (call: unknown[]) => call[0] === 'matching-engine:snapshot:latest'
      );
      expect(latestCalls).toHaveLength(0);
    });
  });

  describe('getSnapshotMetadata with Redis fallback', () => {
    it('should return null when no metadata exists', async () => {
      const service = new SnapshotService(testSnapshotDir, null, false);
      const metadata = await service.getSnapshotMetadata();
      expect(metadata).toBeNull();
    });

    it('should fall back to Redis for metadata', async () => {
      const metadataObj = {
        version: '1.0.0',
        timestamp: Date.now(),
        orderCount: 5,
        matchCount: 3,
        filePath: '/some/path',
      };
      const mockClient = {
        get: jest.fn().mockResolvedValue(JSON.stringify(metadataObj)),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const mockRedis = createMockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      const metadata = await service.getSnapshotMetadata();
      expect(metadata).not.toBeNull();
      expect(metadata!.orderCount).toBe(5);
      expect(mockClient.get).toHaveBeenCalledWith('matching-engine:snapshot:metadata');
    });

    it('should return null when Redis metadata also fails', async () => {
      const mockClient = {
        get: jest.fn().mockRejectedValue(new Error('Redis error')),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const mockRedis = createMockRedisService({
        getClient: jest.fn().mockReturnValue(mockClient),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      const metadata = await service.getSnapshotMetadata();
      expect(metadata).toBeNull();
    });

    it('should handle corrupted metadata file', async () => {
      await fs.mkdir(testSnapshotDir, { recursive: true });
      await fs.writeFile(path.join(testSnapshotDir, 'metadata.json'), 'bad json', 'utf-8');

      const service = new SnapshotService(testSnapshotDir, null, false);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const metadata = await service.getSnapshotMetadata();
      expect(metadata).toBeNull();
      consoleSpy.mockRestore();
    });

    it('should return null when Redis client is null', async () => {
      const mockRedis = createMockRedisService({
        getClient: jest.fn().mockReturnValue(null),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      const metadata = await service.getSnapshotMetadata();
      expect(metadata).toBeNull();
    });

    it('should return null when Redis not connected for loadFromRedis', async () => {
      const mockRedis = createMockRedisService({
        isServiceConnected: jest.fn().mockReturnValue(false),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      const result = await service.loadSnapshot();
      expect(result).toBeNull();
    });
  });

  describe('saveToRedis edge cases', () => {
    it('should handle null Redis service', async () => {
      const service = new SnapshotService(testSnapshotDir, null, true);

      // Should not throw even with redisEnabled=true but null service
      await service.saveSnapshot(orderBook, executionEngine);
    });

    it('should skip when Redis client is null', async () => {
      const mockRedis = createMockRedisService({
        getClient: jest.fn().mockReturnValue(null),
      });
      const service = new SnapshotService(testSnapshotDir, mockRedis, true);

      await service.saveSnapshot(orderBook, executionEngine);
      await new Promise((r) => setTimeout(r, 50));

      // No set calls since client is null
    });
  });
});
