import { Pool, type PoolConfig, type PoolClient } from 'pg';
import type {
  DbClient,
  MatchEvent,
  OrderStatusEvent,
  CancelledRemainderEvent,
  OrderUpdatedEvent,
} from '../../types/db';
import type { DbConfig } from '../../config/db-config';
import { loadDbConfig } from '../../config/db-config';
import type { Order } from '../../types/orders';
import { OrderSide, OrderType, OrderStatus } from '../../types/orders';

/**
 * Convert a `0x`-prefixed hex string into a pg `bytea` buffer. Mirrors the
 * helper used by indexer-v3 + backend-v2's `BYTEA_HEX.to(...)` so the same
 * encoding flows through every service.
 */
function hexToBytea(hex: string): Buffer {
  const stripped =
    hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return Buffer.from(stripped, 'hex');
}

/**
 * Postgres implementation of the DbClient interface.
 *
 * This implementation assumes the following tables (simplified):
 *
 * - orders(id UUID PRIMARY KEY, status TEXT, quantity NUMERIC,
 *   filled_quantity NUMERIC, settlement_fee NUMERIC,
 *   filled_settlement_fee NUMERIC, updated_at TIMESTAMP, ...);
 *
 * - matches(id UUID PRIMARY KEY, lend_order_market_id UUID,
 *   borrow_order_market_id UUID, asset_id UUID, lender_account_id UUID,
 *   borrower_account_id UUID, match_amount NUMERIC, rate NUMERIC,
 *   is_borrower_taker BOOLEAN, maker_fee NUMERIC, taker_fee NUMERIC,
 *   lender_settlement_fee NUMERIC, borrower_settlement_fee NUMERIC,
 *   maturity TIMESTAMP, created_at TIMESTAMP, updated_at TIMESTAMP);
 *   — lend_order_market_id / borrow_order_market_id today store order
 *     UUIDs (semantically should be order_markets.order_market_id;
 *     unrelated TODO, not in C4 scope).
 *
 * - order_markets(order_market_id UUID PK, order_id UUID, market_id BYTEA,
 *   created_at TIMESTAMPTZ) — `market_id` migrated UUID → BYTEA in C4
 *   and now FKs to the shared `market` table (BYTEA-keyed) written by
 *   indexer-v3 + backend's eager-write path.
 *
 * - user_balance(user_address BYTEA, asset BYTEA, available NUMERIC,
 *   in_orders NUMERIC, in_yield_router NUMERIC, used_as_collateral BOOLEAN,
 *   flagged_at BIGINT, applied_by_* …, updated_at TIMESTAMPTZ;
 *   PK (user_address, asset)) — owned by indexer-v3. `in_orders` is the
 *   post-C4 home for match-time locks (was `portfolio.locked_amount`).
 *
 * Column names can be adjusted later without changing the DbWriterService.
 */
export class PostgresDbClient implements DbClient {
  private readonly pool: Pool;

  constructor(config?: DbConfig) {
    const effectiveConfig = config ?? loadDbConfig();

    const poolConfig: PoolConfig = {
      connectionString: effectiveConfig.url,
      max: effectiveConfig.maxPoolSize,
      idleTimeoutMillis: effectiveConfig.idleTimeoutMillis,
    };

    this.pool = new Pool(poolConfig);
  }

  async updateOrderStatus(event: OrderStatusEvent): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `
        UPDATE orders
        SET
          status = $2,
          filled_quantity = $3::numeric,
          filled_settlement_fee = $4::numeric,
          cancel_reason = $6,
          updated_at = to_timestamp($5 / 1000.0)
        WHERE id = $1
        `,
        [
          event.orderId,
          event.status,
          event.filledQuantity,
          event.filledSettlementFeeAmount,
          event.timestamp,
          event.cancelReason ?? null,
        ]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Look up an asset ID by its on-chain token address within an existing transaction.
   *
   * @param client - Active transaction client
   * @param tokenAddress - On-chain token address to resolve
   * @returns The UUID of the matching asset row
   * @throws Error if no matching asset is found
   */
  private async findAssetIdByToken(client: PoolClient, tokenAddress: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `
        SELECT id
        FROM assets
        WHERE token_address = $1
        LIMIT 1
      `,
      [tokenAddress]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Asset not found for token_address=${tokenAddress}`);
    }

    return row.id;
  }

  /**
   * Look up an account ID by its user wallet address within an existing transaction.
   *
   * @param client - Active transaction client
   * @param wallet - User wallet address to resolve
   * @returns The UUID of the matching account row
   * @throws Error if no matching account is found
   */
  private async findAccountIdByWallet(client: PoolClient, wallet: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `
        SELECT id
        FROM accounts
        WHERE user_wallet = $1
        LIMIT 1
      `,
      [wallet]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Account not found for user_wallet=${wallet}`);
    }

    return row.id;
  }

  async insertMatch(event: MatchEvent): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const assetId = await this.findAssetIdByToken(client, event.loanToken);
      const lenderAccountId = await this.findAccountIdByWallet(client, event.lenderWallet);
      const borrowerAccountId = await this.findAccountIdByWallet(client, event.borrowerWallet);

      const insertResult = await client.query(
        `
        INSERT INTO matches (
          id,
          lend_order_market_id,
          borrow_order_market_id,
          asset_id,
          lender_account_id,
          borrower_account_id,
          match_amount,
          rate,
          is_borrower_taker,
          maker_fee,
          taker_fee,
          lender_settlement_fee,
          borrower_settlement_fee,
          maturity,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          to_timestamp($14),
          to_timestamp($15 / 1000.0),
          to_timestamp($15 / 1000.0)
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
        `,
        [
          event.matchId,
          event.lendOrderId, //@note : later change into order market id
          event.borrowOrderId, //@note : later change into order market id
          assetId,
          lenderAccountId,
          borrowerAccountId,
          event.matchedAmount,
          event.rate,
          event.borrowerIsTaker,
          event.makerFeeAmount,
          event.takerFeeAmount,
          event.lenderSettlementFeeAmount,
          event.borrowerSettlementFeeAmount,
          event.maturity,
          event.timestamp,
        ]
      );

      // Lock both lender and borrower balances for pending settlement by
      // bumping `user_balance.in_orders` on the indexer-v3 schema (was
      // `portfolio.locked_amount` pre-C4). Sort updates by `user_address`
      // BYTEA to prevent deadlocks when concurrent transactions lock the
      // same pair in opposite roles. Mirror this ordering in
      // settlement-engine's `lock-release.ts`.
      if (insertResult.rowCount && insertResult.rowCount > 0) {
        const lenderTradeFee = event.borrowerIsTaker ? event.makerFeeAmount : event.takerFeeAmount;
        const borrowerTradeFee = event.borrowerIsTaker
          ? event.takerFeeAmount
          : event.makerFeeAmount;

        const lenderUserAddress = hexToBytea(event.lenderWallet);
        const borrowerUserAddress = hexToBytea(event.borrowerWallet);
        const assetBytea = hexToBytea(event.loanToken);

        const lenderUpdate = {
          sortKey: event.lenderWallet.toLowerCase(),
          query: `
            UPDATE user_balance
            SET in_orders = in_orders + ($1::numeric + $2::numeric + $3::numeric),
                updated_at = NOW()
            WHERE user_address = $4 AND asset = $5
          `,
          params: [
            event.matchedAmount,
            event.lenderSettlementFeeAmount,
            lenderTradeFee,
            lenderUserAddress,
            assetBytea,
          ],
        };

        const borrowerUpdate = {
          sortKey: event.borrowerWallet.toLowerCase(),
          query: `
            UPDATE user_balance
            SET in_orders = in_orders + ($1::numeric + $2::numeric),
                updated_at = NOW()
            WHERE user_address = $3 AND asset = $4
          `,
          params: [
            event.borrowerSettlementFeeAmount,
            borrowerTradeFee,
            borrowerUserAddress,
            assetBytea,
          ],
        };

        // Always lock lower user_address (lowercase hex) first to prevent deadlocks
        const ordered =
          lenderUpdate.sortKey < borrowerUpdate.sortKey
            ? [lenderUpdate, borrowerUpdate]
            : [borrowerUpdate, lenderUpdate];

        for (const update of ordered) {
          await client.query(update.query, update.params);
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async insertCancelledOrder(event: CancelledRemainderEvent): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const accountId = await this.findAccountIdByWallet(client, event.accountWallet);

      await client.query(
        `
        INSERT INTO orders (
          id, account_id, asset_id, side, type, rate, quantity,
          filled_quantity, settlement_fee, filled_settlement_fee,
          status, cancel_reason, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          0, $8, 0,
          'CANCELLED', $10, to_timestamp($9 / 1000.0), to_timestamp($9 / 1000.0)
        )
        ON CONFLICT (id) DO NOTHING
        `,
        [
          event.orderId,
          accountId,
          event.assetId,
          event.side,
          event.type,
          event.rate,
          event.quantity,
          event.settlementFee,
          event.timestamp,
          event.cancelReason ?? 'IOC',
        ]
      );

      for (const marketId of event.marketIds) {
        await client.query(
          `
          INSERT INTO order_markets (order_id, market_id, created_at)
          VALUES ($1, $2, to_timestamp($3 / 1000.0))
          ON CONFLICT DO NOTHING
          `,
          [event.orderId, hexToBytea(marketId), event.timestamp]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Load all active (OPEN or PARTIALLY_FILLED) LIMIT orders from the database.
   *
   * Used to sync the matching engine's in-memory order book with the database
   * on startup, ensuring orders that exist in the DB but are missing from the
   * snapshot are restored.
   *
   * @returns Array of orders in the matching engine's Order format
   */
  async getActiveOrders(): Promise<Order[]> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{
        order_id: string;
        wallet_address: string;
        loan_token: string;
        asset_id: string;
        side: string;
        type: string;
        rate: string;
        status: string;
        original_amount: string;
        remaining_amount: string;
        settlement_fee: string;
        timestamp: string;
        markets: Array<{ marketId: string; maturity: number }>;
      }>(
        `
        SELECT
          o.id AS order_id,
          a.user_wallet AS wallet_address,
          t.token_address AS loan_token,
          o.asset_id,
          o.side,
          o.type,
          o.rate,
          o.status,
          o.quantity AS original_amount,
          (o.quantity::bigint - o.filled_quantity::bigint)::text AS remaining_amount,
          o.settlement_fee,
          EXTRACT(EPOCH FROM o.created_at)::bigint * 1000 AS timestamp,
          json_agg(
            json_build_object(
              'marketId', '0x' || encode(om.market_id, 'hex'),
              'maturity', m.maturity::int
            )
          ) AS markets
        FROM orders o
        JOIN accounts a ON a.id = o.account_id
        JOIN assets t ON t.id = o.asset_id
        JOIN order_markets om ON om.order_id = o.id
        JOIN market m ON m.market_id = om.market_id
        WHERE o.status IN ('OPEN', 'PARTIALLY_FILLED')
          AND o.type = 'LIMIT'
        GROUP BY o.id, a.user_wallet, t.token_address, o.asset_id,
                 o.side, o.type, o.rate, o.status, o.quantity,
                 o.filled_quantity, o.settlement_fee, o.created_at
        `
      );

      return result.rows.map((row): Order => {
        const base = {
          orderId: row.order_id,
          walletAddress: row.wallet_address,
          loanToken: row.loan_token,
          assetId: row.asset_id,
          markets: row.markets,
          timestamp: parseInt(row.timestamp, 10),
          side: row.side as OrderSide,
          type: row.type as OrderType,
          status: row.status as OrderStatus,
          originalAmount: row.original_amount,
          remainingAmount: row.remaining_amount,
          settlementFeeAmount: row.settlement_fee,
          remainingSettlementFeeAmount: row.settlement_fee,
          rate: parseInt(row.rate, 10),
        };

        return base as Order;
      });
    } finally {
      client.release();
    }
  }

  async updateOrderParameters(event: OrderUpdatedEvent): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `
        UPDATE orders
        SET
          rate = $2,
          quantity = $3::numeric,
          settlement_fee = $4::numeric,
          filled_settlement_fee = (settlement_fee::numeric - $5::numeric),
          updated_at = to_timestamp($6 / 1000.0)
        WHERE id = $1
        `,
        [
          event.orderId,
          event.rate,
          event.originalAmount,
          event.settlementFeeAmount,
          event.remainingSettlementFeeAmount,
          event.timestamp,
        ]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
