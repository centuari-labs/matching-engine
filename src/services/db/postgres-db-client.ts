import { Pool, type PoolConfig } from 'pg';
import type { DbClient, MatchEvent, OrderStatusEvent } from '../../types/db';
import type { DbConfig } from '../../config/db-config';
import { loadDbConfig } from '../../config/db-config';

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
 *   created_at TIMESTAMP, updated_at TIMESTAMP);
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

      // Derive filled quantities/fees if not provided explicitly.
      const quantity = event.quantity ? BigInt(event.quantity) : null;
      const remainingAmount = BigInt(event.remainingAmount);
      const settlementFeeAmount = event.settlementFeeAmount
        ? BigInt(event.settlementFeeAmount)
        : null;

      const filledQuantity =
        event.filledQuantity !== undefined
          ? BigInt(event.filledQuantity)
          : quantity !== null
            ? quantity - remainingAmount
            : null;

      const filledSettlementFee =
        event.filledSettlementFeeAmount !== undefined
          ? BigInt(event.filledSettlementFeeAmount)
          : settlementFeeAmount !== null
            ? settlementFeeAmount -
              (quantity !== null && quantity !== 0n
                ? (settlementFeeAmount * remainingAmount) / quantity
                : 0n)
            : null;

      await client.query(
        `
        UPDATE orders
        SET
          status = $2,
          -- quantity & settlement_fee are assumed to be set at order creation time,
          -- so we only update the "filled" fields here.
          filled_quantity = COALESCE($3::numeric, filled_quantity),
          filled_settlement_fee = COALESCE($4::numeric, filled_settlement_fee),
          updated_at = to_timestamp($5 / 1000.0)
        WHERE id = $1
        `,
        [
          event.orderId,
          event.status,
          filledQuantity !== null ? filledQuantity.toString() : null,
          filledSettlementFee !== null ? filledSettlementFee.toString() : null,
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

  async insertMatch(event: MatchEvent): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
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
          to_timestamp($14 / 1000.0),
          to_timestamp($14 / 1000.0)
        )
        ON CONFLICT (id) DO NOTHING
        `,
        [
          event.matchId,
          event.lendOrderId,
          event.borrowOrderId,
          event.loanToken,
          event.lenderWallet,
          event.borrowerWallet,
          event.matchedAmount,
          event.rate,
          event.borrowerIsTaker,
          event.makerFeeAmount,
          event.takerFeeAmount,
          event.lenderSettlementFeeAmount,
          event.borrowerSettlementFeeAmount,
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

