/**
 * Unit tests for PostgresDbClient covering the security-hardening guards:
 *
 *  - H2: updateOrderStatus must not overwrite an already-terminal
 *    (FILLED/CANCELLED) row — the UPDATE is status-precedence guarded and a
 *    zero-rowCount write is logged as a no-op instead of clobbering.
 *  - M4: insertMatch must not silently skip the `in_orders` balance lock when
 *    the user_balance row is absent — a zero-rowCount balance UPDATE rolls the
 *    whole match back.
 *
 * `pg` is mocked so these run without a live Postgres.
 */

const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      end: jest.fn(),
    })),
  };
});

import { PostgresDbClient } from '../services/db/postgres-db-client';
import type { OrderStatusEvent, MatchEvent } from '../types/db';
import { createMatch } from './factories/match-factory';

const DB_CONFIG = {
  url: 'postgres://localhost:5432/test',
  maxPoolSize: 1,
  idleTimeoutMillis: 1000,
};

function makeStatusEvent(overrides: Partial<OrderStatusEvent> = {}): OrderStatusEvent {
  return {
    orderId: '11111111-1111-1111-1111-111111111111',
    status: 'CANCELLED',
    remainingAmount: '1000',
    filledQuantity: '0',
    filledSettlementFeeAmount: '0',
    cancelReason: 'USER_CANCELLED',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('PostgresDbClient — security guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  describe('H2: updateOrderStatus status-precedence guard', () => {
    it('scopes the UPDATE with a NOT IN (FILLED, CANCELLED) guard', async () => {
      mockClientQuery.mockResolvedValue({ rowCount: 1 });
      const client = new PostgresDbClient(DB_CONFIG);

      await client.updateOrderStatus(makeStatusEvent());

      const updateCall = mockClientQuery.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('UPDATE orders')
      );
      expect(updateCall).toBeDefined();
      const sql = updateCall![0] as string;
      expect(sql).toMatch(/status NOT IN \('FILLED', 'CANCELLED'\)/);
    });

    it('does not overwrite a FILLED row with a later CANCELLED (rowCount=0 no-op)', async () => {
      // BEGIN -> UPDATE (0 rows: row is already FILLED) -> COMMIT
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rowCount: 0 }) // UPDATE matched no non-terminal row
        .mockResolvedValueOnce({}); // COMMIT

      const client = new PostgresDbClient(DB_CONFIG);

      // A late CANCELLED arriving after the order already FILLED.
      await expect(
        client.updateOrderStatus(makeStatusEvent({ status: 'CANCELLED' }))
      ).resolves.toBeUndefined();

      // The transaction committed (no throw) but the UPDATE affected 0 rows,
      // i.e. the FILLED row was preserved — last-write-wins is prevented.
      const committed = mockClientQuery.mock.calls.some((c) => c[0] === 'COMMIT');
      const rolledBack = mockClientQuery.mock.calls.some((c) => c[0] === 'ROLLBACK');
      expect(committed).toBe(true);
      expect(rolledBack).toBe(false);
    });

    it('applies the update when the row is still non-terminal (rowCount=1)', async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE applied
        .mockResolvedValueOnce({}); // COMMIT

      const client = new PostgresDbClient(DB_CONFIG);
      await expect(
        client.updateOrderStatus(makeStatusEvent({ status: 'FILLED' }))
      ).resolves.toBeUndefined();

      expect(mockClientQuery.mock.calls.some((c) => c[0] === 'COMMIT')).toBe(true);
    });
  });

  describe('M4: insertMatch balance-lock rowCount guard', () => {
    function primeLookupsAndInsert(balanceRowCount: number): void {
      // Order of queries in insertMatch:
      //  BEGIN, findAssetIdByToken, findAccountIdByWallet(lender),
      //  findAccountIdByWallet(borrower), INSERT matches (RETURNING id),
      //  balance UPDATE x2, COMMIT
      mockClientQuery.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({});
        }
        if (sql.includes('FROM assets')) {
          return Promise.resolve({ rows: [{ id: 'asset-uuid' }] });
        }
        if (sql.includes('FROM accounts')) {
          return Promise.resolve({ rows: [{ id: 'account-uuid' }] });
        }
        if (sql.includes('INSERT INTO matches')) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: 'match-id' }] });
        }
        if (sql.includes('UPDATE user_balance')) {
          return Promise.resolve({ rowCount: balanceRowCount });
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      });
    }

    it('throws and rolls back when a balance row is missing (rowCount=0)', async () => {
      primeLookupsAndInsert(0);
      const client = new PostgresDbClient(DB_CONFIG);
      const event: MatchEvent = createMatch();

      await expect(client.insertMatch(event)).rejects.toThrow(/user_balance row missing/);

      expect(mockClientQuery.mock.calls.some((c) => c[0] === 'ROLLBACK')).toBe(true);
      expect(mockClientQuery.mock.calls.some((c) => c[0] === 'COMMIT')).toBe(false);
    });

    it('commits when both balance rows are present (rowCount=1)', async () => {
      primeLookupsAndInsert(1);
      const client = new PostgresDbClient(DB_CONFIG);
      const event: MatchEvent = createMatch();

      await expect(client.insertMatch(event)).resolves.toBeUndefined();

      expect(mockClientQuery.mock.calls.some((c) => c[0] === 'COMMIT')).toBe(true);
      expect(mockClientQuery.mock.calls.some((c) => c[0] === 'ROLLBACK')).toBe(false);
    });
  });
});
