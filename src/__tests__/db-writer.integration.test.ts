/**
 * DB Writer Integration Tests
 *
 * These tests exercise the DbWriterService against real Postgres, Redis and NATS
 * instances. They verify that:
 *  - NATS `orders.status` messages are consumed and translated into order updates.
 *  - Redis `settlement:matches` stream entries are consumed and inserted as matches.
 *
 * Requirements:
 *  - A reachable Postgres instance configured via DB_/DATABASE_URL env vars
 *    (see db-config).
 *  - A Redis instance running on localhost:6379 (DB 15 is used for tests).
 *  - A NATS server running on localhost:4222 (or overridden via NATS_URL).
 *
 * WARNING: These tests will write to the configured database. Point DB config at
 * a dedicated test database schema before running.
 */

import { Pool, type PoolConfig } from 'pg';
import type { NatsConnection } from 'nats';
import type Redis from 'ioredis';

import { DbWriterService } from '../services/db-writer-service';
import { PostgresDbClient } from '../services/db/postgres-db-client';
import { loadDbConfig } from '../config/db-config';
import { REDIS_CONSUMER_GROUPS, loadRedisConfig } from '../config/redis-config';
import { NATS_TOPICS } from '../config/nats-config';
import { NatsService } from '../services/nats-service';
import { RedisService } from '../services/redis-service';
import { MatchingEngine } from '../core/matching-engine';
import {
  createLendLimitOrder,
  DEFAULT_ORDER_AMOUNT,
  DEFAULT_SETTLEMENT_FEE_AMOUNT,
} from './factories/order-factory';
import { createMatch } from './factories/match-factory';
import { createOrderStatusMessage } from '../types/messages';
import { OrderStatus } from '../types/orders';
import { generateOrderId } from '../utils/helpers';

// Integration tests in this file depend on real Postgres, Redis, and NATS,
// which can take longer than Jest's default 5s timeout. Increase it to avoid
// false negatives due to timeouts.
jest.setTimeout(20000);

const TEST_REDIS_DB = 15;

/**
 * Create a pg.Pool matching the configuration used by PostgresDbClient.
 *
 * This pool is used only for test setup/verification queries; DbWriterService
 * uses its own PostgresDbClient instance internally.
 */
function createTestDbPool(): Pool {
  const config = loadDbConfig();

  const poolConfig: PoolConfig = {
    connectionString: config.url,
    max: config.maxPoolSize,
    idleTimeoutMillis: config.idleTimeoutMillis,
  };

  return new Pool(poolConfig);
}

/**
 * Helper to wait for a condition with polling.
 *
 * @param check - Async function returning truthy when the condition is met.
 * @param timeoutMs - Maximum time to wait in milliseconds.
 * @param intervalMs - Polling interval in milliseconds.
 */
async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await check()) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error('Condition not met within timeout');
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Normalize a numeric string from Postgres for comparison.
 *
 * Postgres NUMERIC columns may include trailing zeros or a decimal point
 * (e.g. "750000.000000"). This helper strips a trailing ".0..." so that
 * values can be compared against integer strings like "750000".
 */
function normalizeNumeric(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  return value.replace(/\.0+$/, '');
}

describe('DbWriterService Integration (requires Postgres, Redis, NATS)', () => {
  let dbPool: Pool;
  let natsConnection: NatsConnection;
  let redisClient: Redis;
  let dbClient: PostgresDbClient;
  let dbWriterService: DbWriterService;
  let natsService: NatsService | null = null;
  let redisService: RedisService | null = null;

  const orderIdsToCleanup: string[] = [];
  const matchIdsToCleanup: string[] = [];
  const assetIdsToCleanup: string[] = [];
  const accountIdsToCleanup: string[] = [];
  // user_balance rows seeded for match-lock tests, as { wallet, asset } hex
  // pairs (0x-prefixed). insertMatch now requires these rows to exist (M4
  // guard), so tests must seed and clean them up.
  const balanceKeysToCleanup: Array<{ wallet: string; asset: string }> = [];

  beforeAll(async () => {
    // Create and verify Postgres connection.
    dbPool = createTestDbPool();
    try {
      await dbPool.query('SELECT 1');

      // Disable constraints/triggers on orders table for tests to bypass FK checks.
      // This ensures we can insert synthetic orders without seeding all related entities.
      try {
        await dbPool.query('ALTER TABLE orders DISABLE TRIGGER ALL');
      } catch (error) {
        // If this fails (e.g., insufficient privileges or missing table), log a warning
        // but continue; tests may still pass if the schema does not enforce FK constraints.
        // eslint-disable-next-line no-console
        console.warn(
          'Could not disable triggers on orders table; FK constraints may still be enforced in tests.',
          error
        );
      }
    } catch (error) {
      console.error(
        'Postgres is not reachable for DB Writer integration tests. Check DB configuration.'
      );
      throw error;
    }

    // Initialize RedisService on the test Redis DB and reuse its client.
    const redisConfig = {
      ...loadRedisConfig(),
      db: TEST_REDIS_DB,
    };
    redisService = new RedisService(redisConfig);
    await redisService.connect();

    const client = redisService.getClient();
    if (!client) {
      throw new Error('Redis client not available after RedisService.connect()');
    }
    redisClient = client;

    // Initialize NatsService and reuse its underlying connection.
    const engine = new MatchingEngine();
    natsService = new NatsService(engine);
    await natsService.connect();

    const nc = natsService.getConnection();
    if (!nc) {
      throw new Error('NATS connection not available after NatsService.connect()');
    }
    natsConnection = nc;

    // Real PostgresDbClient used by DbWriterService.
    dbClient = new PostgresDbClient();

    dbWriterService = new DbWriterService(natsConnection, redisClient, dbClient, {
      maxConcurrency: 5,
      redisConsumerGroup: REDIS_CONSUMER_GROUPS.DB_WRITER,
      redisConsumerName: `db-writer-test-${process.pid}`,
      redisBlockTimeoutMs: 1000,
      redisBatchSize: 10,
    });

    await dbWriterService.start();
  });

  afterAll(async () => {
    if (dbWriterService) {
      await dbWriterService.stop();
    }

    if (natsService) {
      await natsService.disconnect();
    } else if (natsConnection) {
      await natsConnection.drain();
    }

    if (redisService) {
      await redisService.disconnect();
    } else if (redisClient) {
      await redisClient.quit();
    }

    if (dbPool) {
      // Re-enable triggers/constraints on orders table after tests complete.
      try {
        await dbPool.query('ALTER TABLE orders ENABLE TRIGGER ALL');
      } catch {
        // Ignore errors here; the table may not exist or permissions may be limited.
      }

      await dbPool.end();
    }
  });

  afterEach(async () => {
    // Clean up only rows created by these tests.
    if (matchIdsToCleanup.length > 0) {
      try {
        await dbPool.query('DELETE FROM matches WHERE id = ANY($1)', [matchIdsToCleanup]);
      } catch {
        // Ignore if table does not exist in the configured schema.
      }
      matchIdsToCleanup.length = 0;
    }

    if (accountIdsToCleanup.length > 0) {
      try {
        await dbPool.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIdsToCleanup]);
      } catch {
        // Ignore if table does not exist in the configured schema.
      }
      accountIdsToCleanup.length = 0;
    }

    if (assetIdsToCleanup.length > 0) {
      try {
        await dbPool.query('DELETE FROM assets WHERE id = ANY($1)', [assetIdsToCleanup]);
      } catch {
        // Ignore if table does not exist in the configured schema.
      }
      assetIdsToCleanup.length = 0;
    }

    if (orderIdsToCleanup.length > 0) {
      try {
        await dbPool.query('DELETE FROM orders WHERE id = ANY($1)', [orderIdsToCleanup]);
      } catch {
        // Ignore if table does not exist in the configured schema.
      }
      orderIdsToCleanup.length = 0;
    }

    if (balanceKeysToCleanup.length > 0) {
      try {
        for (const { wallet, asset } of balanceKeysToCleanup) {
          await dbPool.query(
            `DELETE FROM user_balance
             WHERE user_address = decode($1, 'hex') AND asset = decode($2, 'hex')`,
            [wallet.replace(/^0x/i, ''), asset.replace(/^0x/i, '')]
          );
        }
      } catch {
        // Ignore if table does not exist in the configured schema.
      }
      balanceKeysToCleanup.length = 0;
    }
  });

  describe('NATS → DB (orders.status)', () => {
    it('should update orders table based on order status messages', async () => {
      // Seed an order row in the DB.
      const baseOrder = createLendLimitOrder();

      // Initial insert uses OPEN status and zero filled quantities/fees.
      const accountId = generateOrderId();
      const assetId = generateOrderId();

      await dbPool.query(
        `
          INSERT INTO orders (
            id,
            account_id,
            asset_id,
            side,
            type,
            rate,
            quantity,
            filled_quantity,
            settlement_fee,
            filled_settlement_fee,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
        [
          baseOrder.orderId,
          accountId,
          assetId,
          baseOrder.side,
          baseOrder.type,
          // Use the order's rate if present, otherwise default to 0.
          (baseOrder as { rate?: number }).rate ?? 0,
          DEFAULT_ORDER_AMOUNT,
          '0',
          DEFAULT_SETTLEMENT_FEE_AMOUNT,
          '0',
          baseOrder.status,
          new Date(),
          new Date(),
        ]
      );

      orderIdsToCleanup.push(baseOrder.orderId);

      // Create a partially filled status update for the same order.
      const updatedOrder = {
        ...baseOrder,
        status: OrderStatus.PartiallyFilled,
        remainingAmount: '250000',
        // Simulate that 75% of the order has filled and fees allocated.
        remainingSettlementFeeAmount: '2500',
      };

      const statusMessage = createOrderStatusMessage(updatedOrder);

      // Publish status message to NATS.
      natsConnection.publish(NATS_TOPICS.ORDERS_STATUS, Buffer.from(JSON.stringify(statusMessage)));

      // Wait until the order row is updated.
      await waitForCondition(async () => {
        const result = await dbPool.query<{
          status: string;
          filled_quantity: string | null;
          filled_settlement_fee: string | null;
        }>(
          `
            SELECT
              status,
              filled_quantity,
              filled_settlement_fee
            FROM orders
            WHERE id = $1
          `,
          [baseOrder.orderId]
        );

        if (result.rows.length === 0) {
          return false;
        }

        const row = result.rows[0];
        return (
          row.status === statusMessage.status &&
          normalizeNumeric(row.filled_quantity) ===
            normalizeNumeric(statusMessage.filledQuantity) &&
          normalizeNumeric(row.filled_settlement_fee) ===
            normalizeNumeric(statusMessage.filledSettlementFeeAmount)
        );
      }, 15000);
    });

    it('should ignore invalid JSON messages and continue processing', async () => {
      // Publish an invalid (non-JSON) payload.
      natsConnection.publish(NATS_TOPICS.ORDERS_STATUS, Buffer.from('not-json'));

      // Give the subscription loop time to process.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // The service should handle the error internally (logged by global logger mock)
      // and continue processing subsequent messages without crashing.
    });
  });

  describe('Redis stream → DB (settlement:matches)', () => {
    it('should insert matches into matches table from Redis stream', async () => {
      const match = createMatch();

      // Seed corresponding asset and account rows so foreign key lookups succeed.
      const assetId = generateOrderId();
      const lenderAccountId = generateOrderId();
      const borrowerAccountId = generateOrderId();

      await dbPool.query(
        `
          INSERT INTO assets (
            id,
            name,
            symbol,
            chain_id,
            token_address,
            is_loan_token,
            avg_ltv,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        `,
        [assetId, 'Test Token', 'TT', 1, match.loanToken, true, 0]
      );

      await dbPool.query(
        `
          INSERT INTO accounts (
            id,
            privy_user_id,
            user_wallet,
            created_at
          )
          VALUES ($1, $2, $3, NOW()),
                 ($4, $5, $6, NOW())
        `,
        [
          lenderAccountId,
          'lender-test-user',
          match.lenderWallet,
          borrowerAccountId,
          'borrower-test-user',
          match.borrowerWallet,
        ]
      );

      assetIdsToCleanup.push(assetId);
      accountIdsToCleanup.push(lenderAccountId, borrowerAccountId);
      matchIdsToCleanup.push(match.matchId);

      // Seed minimal lend/borrow orders so foreign key constraints on matches.lend_order_market_id
      // and matches.borrow_order_market_id are satisfied.
      await dbPool.query(
        `
          INSERT INTO orders (
            id,
            account_id,
            asset_id,
            side,
            type,
            rate,
            quantity,
            filled_quantity,
            settlement_fee,
            filled_settlement_fee,
            status,
            created_at,
            updated_at
          )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, '0', '0', '0', $8, NOW(), NOW()),
            ($9, $10, $3, $11, $5, $6, $7, '0', '0', '0', $8, NOW(), NOW())
        `,
        [
          match.lendOrderId,
          lenderAccountId,
          assetId,
          'LEND',
          'LIMIT',
          match.rate,
          match.matchedAmount,
          'OPEN',
          match.borrowOrderId,
          borrowerAccountId,
          'BORROW',
        ]
      );

      orderIdsToCleanup.push(match.lendOrderId, match.borrowOrderId);

      // Seed user_balance rows for both wallets so insertMatch's in_orders lock
      // UPDATEs find a row (M4 guard rolls back the match if a row is missing).
      await dbPool.query(
        `
          INSERT INTO user_balance (user_address, asset, available, in_orders)
          VALUES
            (decode($1, 'hex'), decode($3, 'hex'), 1000000000, 0),
            (decode($2, 'hex'), decode($3, 'hex'), 1000000000, 0)
          ON CONFLICT (user_address, asset) DO NOTHING
        `,
        [
          match.lenderWallet.replace(/^0x/i, ''),
          match.borrowerWallet.replace(/^0x/i, ''),
          match.loanToken.replace(/^0x/i, ''),
        ]
      );
      balanceKeysToCleanup.push(
        { wallet: match.lenderWallet, asset: match.loanToken },
        { wallet: match.borrowerWallet, asset: match.loanToken }
      );

      const fields: string[] = [
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

      // Call the private handler directly to exercise mapping + DB insert.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (dbWriterService as any).handleRedisEntry('0-1', fields);

      const result = await dbPool.query<{
        id: string;
        match_amount: string;
        rate: number;
        is_borrower_taker: boolean;
        maker_fee: string;
        taker_fee: string;
        lender_settlement_fee: string;
        borrower_settlement_fee: string;
      }>(
        `
          SELECT
            id,
            match_amount,
            rate,
            is_borrower_taker,
            maker_fee,
            taker_fee,
            lender_settlement_fee,
            borrower_settlement_fee
          FROM matches
          WHERE id = $1
        `,
        [match.matchId]
      );

      expect(result.rows).toHaveLength(1);
      const row = result.rows[0];
      expect(row.id).toBe(match.matchId);
      expect(row.match_amount).toBe(match.matchedAmount);
      expect(Number(row.rate)).toBe(match.rate);
      expect(row.is_borrower_taker).toBe(match.borrowerIsTaker);
      expect(row.maker_fee).toBe(match.makerFeeAmount);
      expect(row.taker_fee).toBe(match.takerFeeAmount);
      expect(row.lender_settlement_fee).toBe(match.lenderSettlementFeeAmount);
      expect(row.borrower_settlement_fee).toBe(match.borrowerSettlementFeeAmount);
    });

    it('should acknowledge and skip invalid match entries', async () => {
      const badFields: string[] = [
        'matchId',
        '00000000-0000-0000-0000-000000000000',
        'lendOrderId',
        '00000000-0000-0000-0000-000000000001',
        'borrowOrderId',
        '00000000-0000-0000-0000-000000000002',
        // Missing required numeric / address fields to trigger validation failure.
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (dbWriterService as any).handleRedisEntry('0-2', badFields);

      const result = await dbPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM matches WHERE id = $1',
        ['00000000-0000-0000-0000-000000000000']
      );

      expect(result.rows[0]?.count).toBe('0');
    });

    it('should fail when asset or accounts are missing for a match', async () => {
      const match = createMatch({
        loanToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        lenderWallet: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        borrowerWallet: '0x477Dcb9AE26E73C42D1a0172c1c216f38316EfE1',
      });

      await expect(dbClient.insertMatch(match)).rejects.toThrow(
        'Asset not found for token_address'
      );
    });
  });
});
