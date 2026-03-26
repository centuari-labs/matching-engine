/**
 * NATS Service Unit Tests
 *
 * Tests for NatsService using mocked NATS client to avoid requiring a running NATS server.
 */

import { MatchingEngine } from '../core/matching-engine';
import { NatsService } from '../services/nats-service';
import type { NatsConfig } from '../config/nats-config';

// Define mock objects that jest.mock can reference via hoisting.
// jest.mock is hoisted above imports, so we use a factory that creates
// objects lazily within the mock scope.
const mockSubscription = {
  drain: jest.fn().mockResolvedValue(undefined),
  [Symbol.asyncIterator]: jest.fn().mockReturnValue({
    next: jest.fn().mockResolvedValue({ done: true, value: undefined }),
    return: jest.fn().mockResolvedValue({ done: true, value: undefined }),
  }),
};

const mockNatsConnection = {
  subscribe: jest.fn().mockReturnValue(mockSubscription),
  publish: jest.fn(),
  drain: jest.fn().mockResolvedValue(undefined),
  closed: jest.fn().mockReturnValue(new Promise(() => {})),
};

jest.mock('nats', () => {
  return {
    connect: jest.fn(),
  };
});

// Mock config for testing
const mockConfig: NatsConfig = {
  url: 'nats://localhost:4222',
  maxReconnectAttempts: 3,
  reconnectTimeWait: 1000,
  timeout: 5000,
};

describe('NatsService', () => {
  let engine: MatchingEngine;
  let natsService: NatsService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock return values after clearAllMocks
    mockSubscription.drain.mockResolvedValue(undefined);
    mockSubscription[Symbol.asyncIterator].mockReturnValue({
      next: jest.fn().mockResolvedValue({ done: true, value: undefined }),
      return: jest.fn().mockResolvedValue({ done: true, value: undefined }),
    });
    mockNatsConnection.subscribe.mockReturnValue(mockSubscription);
    mockNatsConnection.drain.mockResolvedValue(undefined);
    mockNatsConnection.closed.mockReturnValue(new Promise(() => {}));

    const { connect } = require('nats');
    (connect as jest.Mock).mockResolvedValue(mockNatsConnection);

    engine = new MatchingEngine();
  });

  afterEach(async () => {
    if (natsService && natsService.isServiceConnected()) {
      await natsService.disconnect();
    }
  });

  describe('Service Initialization', () => {
    it('should create a NATS service instance', () => {
      natsService = new NatsService(engine, mockConfig);
      expect(natsService).toBeDefined();
      expect(natsService.isServiceConnected()).toBe(false);
    });

    it('should load config from environment if not provided', () => {
      process.env.NATS_URL = 'nats://test:4222';
      natsService = new NatsService(engine);
      expect(natsService).toBeDefined();
      delete process.env.NATS_URL;
    });

    it('should return correct stats when not connected', () => {
      natsService = new NatsService(engine, mockConfig);
      const stats = natsService.getStats();

      expect(stats.connected).toBe(false);
      expect(stats.subscriptions).toBe(0);
      expect(stats.config.url).toBe('nats://localhost:4222');
    });
  });

  describe('Connection Management', () => {
    it('should connect to NATS', async () => {
      natsService = new NatsService(engine, mockConfig);
      await natsService.connect();

      expect(natsService.isServiceConnected()).toBe(true);
    });

    it('should not connect twice', async () => {
      natsService = new NatsService(engine, mockConfig);
      await natsService.connect();

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      await natsService.connect();

      expect(consoleSpy).toHaveBeenCalledWith('NATS service is already connected');
      consoleSpy.mockRestore();
    });

    it('should disconnect gracefully', async () => {
      natsService = new NatsService(engine, mockConfig);
      await natsService.connect();
      expect(natsService.isServiceConnected()).toBe(true);

      await natsService.disconnect();
      expect(natsService.isServiceConnected()).toBe(false);
    });

    it('should handle disconnect when not connected', async () => {
      natsService = new NatsService(engine, mockConfig);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      await natsService.disconnect();

      expect(consoleSpy).toHaveBeenCalledWith('NATS service is not connected');
      consoleSpy.mockRestore();
    });

    it('should handle connection failure', async () => {
      const { connect } = require('nats');
      (connect as jest.Mock).mockRejectedValueOnce(new Error('Connection refused'));

      natsService = new NatsService(engine, {
        url: 'nats://invalid:9999',
        maxReconnectAttempts: 0,
        reconnectTimeWait: 100,
        timeout: 500,
      });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      await expect(natsService.connect()).rejects.toThrow('NATS connection failed');
      consoleSpy.mockRestore();
    });
  });

  describe('Service Statistics', () => {
    it('should return connection instance when connected', async () => {
      natsService = new NatsService(engine, mockConfig);
      await natsService.connect();

      const connection = natsService.getConnection();
      expect(connection).not.toBeNull();
    });

    it('should return null connection when not connected', () => {
      natsService = new NatsService(engine, mockConfig);

      const connection = natsService.getConnection();
      expect(connection).toBeNull();
    });

    it('should track subscriptions after connection', async () => {
      natsService = new NatsService(engine, mockConfig);
      await natsService.connect();

      const stats = natsService.getStats();
      expect(stats.connected).toBe(true);
      expect(stats.subscriptions).toBe(5); // 4 order types + cancel
    });
  });

  describe('Configuration Validation', () => {
    it('should accept valid configuration', () => {
      const validConfig: NatsConfig = {
        url: 'nats://localhost:4222',
        user: 'testuser',
        password: 'testpass',
        maxReconnectAttempts: 5,
        reconnectTimeWait: 1000,
        timeout: 5000,
      };

      natsService = new NatsService(engine, validConfig);
      expect(natsService).toBeDefined();
    });

    it('should accept token authentication', () => {
      const tokenConfig: NatsConfig = {
        url: 'nats://localhost:4222',
        token: 'test-token',
        maxReconnectAttempts: 5,
        reconnectTimeWait: 1000,
        timeout: 5000,
      };

      natsService = new NatsService(engine, tokenConfig);
      const stats = natsService.getStats();
      expect(stats.config.hasAuth).toBe(true);
    });

    it('should accept multiple server URLs', () => {
      const clusterConfig: NatsConfig = {
        url: 'nats://server1:4222,nats://server2:4222',
        maxReconnectAttempts: 5,
        reconnectTimeWait: 1000,
        timeout: 5000,
      };

      natsService = new NatsService(engine, clusterConfig);
      expect(natsService).toBeDefined();
    });

    it('should report no auth when no credentials provided', () => {
      natsService = new NatsService(engine, mockConfig);
      const stats = natsService.getStats();
      expect(stats.config.hasAuth).toBe(false);
    });
  });

  describe('Subscription Setup', () => {
    it('should subscribe to all 5 order topics on connect', async () => {
      natsService = new NatsService(engine, mockConfig);
      await natsService.connect();

      expect(mockNatsConnection.subscribe).toHaveBeenCalledTimes(5);
      expect(mockNatsConnection.subscribe).toHaveBeenCalledWith('orders.lend.market');
      expect(mockNatsConnection.subscribe).toHaveBeenCalledWith('orders.lend.limit');
      expect(mockNatsConnection.subscribe).toHaveBeenCalledWith('orders.borrow.market');
      expect(mockNatsConnection.subscribe).toHaveBeenCalledWith('orders.borrow.limit');
      expect(mockNatsConnection.subscribe).toHaveBeenCalledWith('orders.cancel');
    });

    it('should drain subscriptions on disconnect', async () => {
      natsService = new NatsService(engine, mockConfig);
      await natsService.connect();
      await natsService.disconnect();

      expect(mockSubscription.drain).toHaveBeenCalled();
      expect(mockNatsConnection.drain).toHaveBeenCalled();
    });
  });
});
