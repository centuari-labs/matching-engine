/**
 * Maturity-expiry sweep (service layer).
 *
 * A resting order whose market has passed maturity can never validly match, so
 * it would otherwise sit on the book forever locking the user's spendable
 * balance (the backend subtracts open orders when computing available balance).
 * This sweep removes such orders from the in-memory book (via the engine, which
 * keeps `core/` I/O-free) and publishes a CANCELLED status with
 * `cancelReason = MARKET_MATURED` for each, so the db-writer persists the
 * terminal state and the user's balance frees up.
 *
 * The backend rejects *new* placements into matured markets; this sweep closes
 * the loop for orders that were already resting when maturity passed.
 */

import type { NatsConnection } from 'nats';
import type { MatchingEngine } from '../core/matching-engine';
import { NATS_TOPICS } from '../config/nats-config';
import { createOrderStatusMessage } from '../types/messages';
import { OrderStatus } from '../types/orders';
import { createLogger } from '../utils/logger';

const log = createLogger('order-expiry');

/**
 * Cancel reason stamped on orders auto-expired because their market matured.
 */
export const MARKET_MATURED_CANCEL_REASON = 'MARKET_MATURED' as const;

/**
 * Expire all resting orders past maturity and publish a CANCELLED status for
 * each. Idempotent across ticks: once an order is removed from the book it is no
 * longer returned, so re-running does nothing.
 *
 * @param engine - The matching engine holding the in-memory order book.
 * @param nc - The NATS connection used to publish `orders.status`.
 * @param nowSeconds - Current time as a unix timestamp in seconds.
 * @returns The number of orders expired this tick.
 */
export function expireMaturedOrders(
  engine: MatchingEngine,
  nc: NatsConnection,
  nowSeconds: number
): number {
  const expired = engine.expireMaturedOrders(nowSeconds);

  for (const order of expired) {
    const statusMessage = createOrderStatusMessage({
      orderId: order.orderId,
      status: OrderStatus.Cancelled,
      remainingAmount: order.remainingAmount,
      originalAmount: order.originalAmount,
      settlementFeeAmount: order.settlementFeeAmount,
      remainingSettlementFeeAmount: order.remainingSettlementFeeAmount,
      cancelReason: MARKET_MATURED_CANCEL_REASON,
    });
    nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(statusMessage));
  }

  if (expired.length > 0) {
    log.info({ count: expired.length }, 'expired matured orders');
  }

  return expired.length;
}
