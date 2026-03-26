/**
 * PostgresDbClient Unit Tests
 *
 * Tests for PostgresDbClient with a fully mocked pg Pool.
 */

import { PostgresDbClient } from '../services/db/postgres-db-client';
import { createMatch } from './factories/match-factory';
import { generateOrderId } from '../utils/helpers';

// Mock pg module
const mockPoolClient = {
  query: jest.fn(),
  release: jest.fn(),
};

const mockPool = {
  connect: jest.fn().mockResolvedValue(mockPoolClient),
  end: jest.fn().mockResolvedValue(undefined),
};

jest.mock('pg', () => ({
  Pool: jest.fn(() => mockPool),
}));

// Mock db-config to avoid requiring DB_URL env var
jest.mock('../config/db-config', () => ({
  loadDbConfig: jest.fn(() => ({
    url: 'postgres://test:test@localhost:5432/test',
    maxPoolSize: 10,
    idleTimeoutMillis: 30000,
  })),
}));

describe('PostgresDbClient', () => {
  let client: PostgresDbClient;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset query mock to default behavior
    mockPoolClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
    client = new PostgresDbClient();
  });

  describe('constructor', () => {
    it('should create a client with default config', () => {
      expect(client).toBeDefined();
    });

    it('should accept custom config', () => {
      const customClient = new PostgresDbClient({
        url: 'postgres://custom:custom@localhost:5432/custom',
        maxPoolSize: 5,
        idleTimeoutMillis: 10000,
      });
      expect(customClient).toBeDefined();
    });
  });

  describe('updateOrderStatus', () => {
    it('should execute BEGIN, UPDATE, and COMMIT', async () => {
      const event = {
        orderId: generateOrderId(),
        status: 'PARTIALLY_FILLED' as const,
        remainingAmount: '500000',
        quantity: '1000000',
        filledQuantity: '500000',
        settlementFeeAmount: '10000',
        filledSettlementFeeAmount: '5000',
        timestamp: Date.now(),
      };

      await client.updateOrderStatus(event);

      expect(mockPoolClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockPoolClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE orders'),
        expect.arrayContaining([event.orderId, event.status])
      );
      expect(mockPoolClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockPoolClient.release).toHaveBeenCalled();
    });

    it('should derive filledQuantity from quantity - remainingAmount', async () => {
      const event = {
        orderId: generateOrderId(),
        status: 'PARTIALLY_FILLED' as const,
        remainingAmount: '250000',
        quantity: '1000000',
        settlementFeeAmount: '10000',
        timestamp: Date.now(),
      };

      await client.updateOrderStatus(event);

      // filledQuantity should be 1000000 - 250000 = 750000
      const updateCall = mockPoolClient.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('UPDATE orders')
      );

      expect(updateCall).toBeDefined();
      expect(updateCall![1][2]).toBe('750000'); // filledQuantity param
    });

    it('should handle FILLED status', async () => {
      const event = {
        orderId: generateOrderId(),
        status: 'FILLED' as const,
        remainingAmount: '0',
        quantity: '1000000',
        filledQuantity: '1000000',
        timestamp: Date.now(),
      };

      await client.updateOrderStatus(event);
      expect(mockPoolClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should ROLLBACK on error and release client', async () => {
      mockPoolClient.query.mockImplementation((sql: string) => {
        if (sql.includes('UPDATE')) {
          return Promise.reject(new Error('constraint violation'));
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const event = {
        orderId: generateOrderId(),
        status: 'FILLED' as const,
        remainingAmount: '0',
        timestamp: Date.now(),
      };

      await expect(client.updateOrderStatus(event)).rejects.toThrow('constraint violation');
      expect(mockPoolClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockPoolClient.release).toHaveBeenCalled();
    });

    it('should handle event without quantity (null filledQuantity)', async () => {
      const event = {
        orderId: generateOrderId(),
        status: 'OPEN' as const,
        remainingAmount: '1000000',
        timestamp: Date.now(),
      };

      await client.updateOrderStatus(event);

      const updateCall = mockPoolClient.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('UPDATE orders')
      );

      expect(updateCall).toBeDefined();
      // filledQuantity should be null when quantity is not provided
      expect(updateCall![1][2]).toBeNull();
    });

    it('should handle event with explicit filledQuantity', async () => {
      const event = {
        orderId: generateOrderId(),
        status: 'PARTIALLY_FILLED' as const,
        remainingAmount: '300000',
        quantity: '1000000',
        filledQuantity: '700000',
        settlementFeeAmount: '10000',
        filledSettlementFeeAmount: '7000',
        timestamp: Date.now(),
      };

      await client.updateOrderStatus(event);

      const updateCall = mockPoolClient.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('UPDATE orders')
      );

      expect(updateCall![1][2]).toBe('700000'); // explicit filledQuantity
      expect(updateCall![1][3]).toBe('7000'); // explicit filledSettlementFee
    });
  });

  describe('insertMatch', () => {
    it('should look up asset and accounts, then insert match', async () => {
      const match = createMatch();

      // Mock findAssetIdByToken
      mockPoolClient.query.mockImplementation((sql: string | { text: string }) => {
        const sqlStr = typeof sql === 'string' ? sql : sql.text;
        if (sqlStr.includes('SELECT id') && sqlStr.includes('assets')) {
          return Promise.resolve({ rows: [{ id: 'asset-uuid' }] });
        }
        if (sqlStr.includes('SELECT id') && sqlStr.includes('accounts')) {
          return Promise.resolve({ rows: [{ id: 'account-uuid' }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await client.insertMatch(match);

      expect(mockPoolClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockPoolClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO matches'),
        expect.arrayContaining([match.matchId])
      );
      expect(mockPoolClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockPoolClient.release).toHaveBeenCalled();
    });

    it('should throw when asset is not found', async () => {
      const match = createMatch({
        loanToken: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      });

      mockPoolClient.query.mockImplementation((sql: string) => {
        if (sql.includes('assets')) {
          return Promise.resolve({ rows: [] }); // No asset found
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(client.insertMatch(match)).rejects.toThrow('Asset not found for token_address');
      expect(mockPoolClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockPoolClient.release).toHaveBeenCalled();
    });

    it('should throw when lender account is not found', async () => {
      const match = createMatch();

      let accountQueryCount = 0;
      mockPoolClient.query.mockImplementation((sql: string) => {
        if (sql.includes('assets')) {
          return Promise.resolve({ rows: [{ id: 'asset-uuid' }] });
        }
        if (sql.includes('accounts')) {
          accountQueryCount++;
          if (accountQueryCount === 1) {
            return Promise.resolve({ rows: [] }); // Lender not found
          }
          return Promise.resolve({ rows: [{ id: 'borrower-uuid' }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(client.insertMatch(match)).rejects.toThrow('Account not found for user_wallet');
    });

    it('should throw when borrower account is not found', async () => {
      const match = createMatch();

      let accountQueryCount = 0;
      mockPoolClient.query.mockImplementation((sql: string) => {
        if (sql.includes('assets')) {
          return Promise.resolve({ rows: [{ id: 'asset-uuid' }] });
        }
        if (sql.includes('accounts')) {
          accountQueryCount++;
          if (accountQueryCount === 1) {
            return Promise.resolve({ rows: [{ id: 'lender-uuid' }] });
          }
          return Promise.resolve({ rows: [] }); // Borrower not found
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(client.insertMatch(match)).rejects.toThrow('Account not found for user_wallet');
    });

    it('should ROLLBACK on INSERT error', async () => {
      const match = createMatch();

      mockPoolClient.query.mockImplementation((sql: string) => {
        if (sql.includes('assets')) {
          return Promise.resolve({ rows: [{ id: 'asset-uuid' }] });
        }
        if (sql.includes('accounts')) {
          return Promise.resolve({ rows: [{ id: 'account-uuid' }] });
        }
        if (sql.includes('INSERT INTO matches')) {
          return Promise.reject(new Error('unique constraint violation'));
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(client.insertMatch(match)).rejects.toThrow('unique constraint violation');
      expect(mockPoolClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockPoolClient.release).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should end the pool', async () => {
      await client.close();
      expect(mockPool.end).toHaveBeenCalled();
    });
  });
});
