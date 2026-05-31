/**
 * NATS Message Handlers
 *
 * Implements handler functions for processing NATS messages and interacting
 * with the matching engine.
 */

import type { Msg, NatsConnection } from 'nats';
import type { MatchingEngine } from '../core/matching-engine';
import {
  lendMarketOrderSchema,
  lendLimitOrderSchema,
  borrowMarketOrderSchema,
  borrowLimitOrderSchema,
} from '../types/orders';
import {
  cancelOrderMessageSchema,
  updateOrderMessageSchema,
  createErrorMessage,
  createOrderStatusMessage,
  ERROR_CODES,
  type ErrorMessage,
  type CancelledRemainderMessage,
  type CancelOrderMessage,
  type CancelReply,
  type ErrorCode,
} from '../types/messages';
import type { Match, MatchResult } from '../types/matches';
import { OrderSide, OrderStatus, OrderType } from '../types/orders';
import { NATS_TOPICS } from '../config/nats-config';
import type { Order } from '../types/orders';
import { isLimitOrder } from '../types/orders';
import {
  addBigNumbers,
  subtractBigNumbers,
  isZero,
  generateOrderId,
  calculateProRataSettlementFee,
} from '../utils/helpers';
import { createLogger } from '../utils/logger';

const log = createLogger('message-handlers');

/**
 * Handler context containing dependencies
 */
export interface HandlerContext {
  /**
   * NATS connection instance
   */
  nc: NatsConnection;

  /**
   * Matching engine instance
   */
  engine: MatchingEngine;
}

/**
 * Parse and validate a JSON message
 *
 * @param data - Raw message data
 * @param schema - Zod schema to validate against
 * @returns Parsed and validated data
 * @throws {Error} If parsing or validation fails
 */
function parseMessage<T>(data: Uint8Array, schema: { parse: (data: unknown) => T }): T {
  try {
    const text = new TextDecoder().decode(data);
    const json = JSON.parse(text);
    return schema.parse(json);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Message parse error: ${error.message}`);
    }
    throw new Error('Unknown message parse error');
  }
}

/**
 * Publish an error message to the errors topic
 *
 * @param ctx - Handler context
 * @param error - Error message object
 */
function publishError(ctx: HandlerContext, error: ErrorMessage): void {
  try {
    const message = JSON.stringify(error);
    ctx.nc.publish(NATS_TOPICS.ERRORS, message);
  } catch (err) {
    log.error({ err }, 'failed to publish error message');
  }
}

/**
 * Publish order status updates for taker and affected maker orders
 *
 * @param ctx - Handler context
 * @param orderId - The taker order ID
 * @param result - Match result containing affected orders
 */
/**
 * Full order info needed for publishing status updates and cancelled remainder.
 */
interface OrderInfo {
  originalAmount: string;
  settlementFeeAmount: string;
  remainingSettlementFeeAmount?: string;
  /** Required for cancelled remainder — wallet address of the order owner */
  walletAddress?: string;
  /** Required for cancelled remainder — asset UUID */
  assetId?: string;
  /** Required for cancelled remainder — order side */
  side?: OrderSide;
  /** Required for cancelled remainder — order type */
  type?: string;
  /** Required for cancelled remainder — market IDs */
  marketIds?: string[];
}

function publishOrderStatusUpdates(
  ctx: HandlerContext,
  orderId: string,
  result: MatchResult,
  originalOrder?: OrderInfo
): void {
  try {
    // Publish taker order status
    if (result.remainingOrder && originalOrder) {
      // Order is partially filled or still open (limit order still in book)
      const takerStatusMessage = createOrderStatusMessage({
        orderId: result.remainingOrder.orderId,
        status: result.remainingOrder.status,
        remainingAmount: result.remainingOrder.remainingAmount,
        originalAmount: originalOrder.originalAmount,
        settlementFeeAmount: originalOrder.settlementFeeAmount,
        remainingSettlementFeeAmount: originalOrder.remainingSettlementFeeAmount,
      });
      ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(takerStatusMessage));
    } else if (result.matches.length > 0 && originalOrder) {
      // No remaining order in book — compute actual fill from matches.
      // For limit orders removed from book, totalMatched == originalAmount.
      // For market orders (IOC, never in book), totalMatched may be less.
      const totalMatched = result.matches.reduce(
        (sum, m) => addBigNumbers(sum, m.matchedAmount),
        '0'
      );
      const remaining = subtractBigNumbers(originalOrder.originalAmount, totalMatched);
      const isFull = isZero(remaining);

      const takerStatusMessage = createOrderStatusMessage({
        orderId,
        status: OrderStatus.Filled,
        remainingAmount: isFull ? '0' : remaining,
        originalAmount: originalOrder.originalAmount,
        settlementFeeAmount: originalOrder.settlementFeeAmount,
        remainingSettlementFeeAmount: isFull
          ? '0'
          : (originalOrder.remainingSettlementFeeAmount ?? '0'),
      });
      ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(takerStatusMessage));

      // If partially filled market order, publish a cancelled remainder order
      if (
        !isFull &&
        originalOrder.walletAddress &&
        originalOrder.assetId &&
        originalOrder.side &&
        originalOrder.marketIds
      ) {
        const remainingSettlementFee = originalOrder.remainingSettlementFeeAmount ?? '0';

        const cancelledRemainder: CancelledRemainderMessage = {
          orderId: generateOrderId(),
          originalOrderId: orderId,
          accountWallet: originalOrder.walletAddress,
          assetId: originalOrder.assetId,
          side: originalOrder.side,
          type: OrderType.Market,
          rate: 0,
          quantity: remaining,
          settlementFee: remainingSettlementFee,
          marketIds: originalOrder.marketIds,
          cancelReason: 'IOC',
          timestamp: Date.now(),
        };
        ctx.nc.publish(NATS_TOPICS.ORDERS_CANCELLED_REMAINDER, JSON.stringify(cancelledRemainder));
      }
    } else if (originalOrder) {
      // Market order with no matches — cancel it so DB Writer updates the row
      const cancelMessage = createOrderStatusMessage({
        orderId,
        status: 'CANCELLED',
        remainingAmount: originalOrder.originalAmount,
        originalAmount: originalOrder.originalAmount,
        settlementFeeAmount: originalOrder.settlementFeeAmount,
        remainingSettlementFeeAmount: originalOrder.settlementFeeAmount,
        cancelReason: 'IOC',
      });
      ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(cancelMessage));
    }

    // Publish status updates for all affected maker orders
    for (const affectedOrder of result.affectedMakerOrders) {
      const statusMessage = createOrderStatusMessage(affectedOrder);
      ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(statusMessage));
    }
  } catch (err) {
    log.error({ err, orderId }, 'failed to publish order status updates');
    publishError(
      ctx,
      createErrorMessage(
        ERROR_CODES.INTERNAL_ERROR,
        'Failed to publish order status updates',
        orderId
      )
    );
  }
}

/**
 * Publish individual recent-trade events to NATS for each match.
 *
 * The WebSocket gateway subscribes to `matches.created` and broadcasts
 * each event to the `recent-trades:{assetId}` Socket.IO room.
 *
 * @param ctx - Handler context
 * @param assetId - Asset UUID for the traded token
 * @param takerSide - Side of the taker order (the order that was just submitted)
 * @param matches - Array of matches produced by the matching engine
 */
function publishMatchCreatedEvents(
  ctx: HandlerContext,
  assetId: string,
  takerSide: OrderSide,
  matches: Match[]
): void {
  try {
    for (const match of matches) {
      const tradeEvent = {
        assetId,
        side: takerSide,
        amount: match.matchedAmount,
        rate: match.rate,
        timestamp: match.timestamp,
      };
      ctx.nc.publish(NATS_TOPICS.MATCHES_CREATED, JSON.stringify(tradeEvent));
    }
  } catch (err) {
    log.error({ err }, 'failed to publish match created events');
  }
}

/**
 * Generic order handler — all order types share the same processing pipeline.
 * Only the Zod schema (for validation) and the log label differ.
 */
function handleOrder<T extends Order>(
  ctx: HandlerContext,
  data: Uint8Array,
  schema: { parse: (data: unknown) => T },
  label: string
): void {
  try {
    const order = parseMessage(data, schema);

    log.debug({ orderId: order.orderId, type: label }, 'processing order');

    const result = ctx.engine.submitOrder(order);

    publishOrderStatusUpdates(ctx, order.orderId, result, {
      originalAmount: order.originalAmount,
      settlementFeeAmount: order.settlementFeeAmount,
      remainingSettlementFeeAmount: result.takerRemainingSettlementFeeAmount,
      walletAddress: order.walletAddress,
      assetId: order.assetId,
      side: order.side,
      type: order.type,
      marketIds: order.markets.map((m) => m.marketId),
    });

    if (result.matches.length > 0) {
      publishMatchCreatedEvents(ctx, order.assetId, order.side, result.matches);
    }

    log.debug(
      { orderId: order.orderId, matchCount: result.matches.length, type: label },
      'order processed'
    );
  } catch (error) {
    log.error({ err: error, type: label }, 'error handling order');
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    publishError(ctx, createErrorMessage(ERROR_CODES.INVALID_ORDER, errorMsg));
  }
}

export const handleLendMarketOrder = (ctx: HandlerContext, data: Uint8Array): void =>
  handleOrder(ctx, data, lendMarketOrderSchema, 'lend market order');

export const handleLendLimitOrder = (ctx: HandlerContext, data: Uint8Array): void =>
  handleOrder(ctx, data, lendLimitOrderSchema, 'lend limit order');

export const handleBorrowMarketOrder = (ctx: HandlerContext, data: Uint8Array): void =>
  handleOrder(ctx, data, borrowMarketOrderSchema, 'borrow market order');

export const handleBorrowLimitOrder = (ctx: HandlerContext, data: Uint8Array): void =>
  handleOrder(ctx, data, borrowLimitOrderSchema, 'borrow limit order');

/**
 * Compute the authoritative cancel outcome and apply its side effects.
 *
 * The engine's NATS handlers are synchronous and run to completion on the
 * single-threaded event loop, so this check-and-remove is atomic: nothing else
 * can match the order between `getOrderInfo` and `cancelOrder`. That atomicity
 * is what makes the request/reply verdict trustworthy.
 *
 * Side effect: on `CANCELLED`, publishes `orders.status: CANCELLED` so the
 * orderbook/WebSocket consumers and the (idempotent) DB writer stay in sync —
 * the same status the legacy fire-and-forget path emitted.
 *
 * Shared by both `handleCancelOrder` (legacy fire-and-forget) and
 * `handleCancelOrderRequest` (request/reply) so the verdict logic lives once.
 */
function computeCancelOutcome(ctx: HandlerContext, request: CancelOrderMessage): CancelReply {
  // Get order info before cancellation (needed for status message)
  const orderInfo = ctx.engine.getOrderInfo(request.orderId);
  if (!orderInfo) {
    return { outcome: 'NOT_FOUND', orderId: request.orderId };
  }

  // Cancel order in matching engine. The order is in the book (orderInfo was
  // found), so it is OPEN/PARTIALLY_FILLED — the only reason this returns false
  // is a wallet-owner mismatch.
  const success = ctx.engine.cancelOrder(request.orderId, request.walletAddress);
  if (!success) {
    return { outcome: 'NOT_OWNER', orderId: request.orderId };
  }

  // Publish status update with filled amounts (orderbook/WS + DB writer persist)
  const statusMessage = createOrderStatusMessage({
    orderId: request.orderId,
    status: 'CANCELLED',
    remainingAmount: orderInfo.remainingAmount,
    originalAmount: orderInfo.originalAmount,
    settlementFeeAmount: orderInfo.settlementFeeAmount,
    remainingSettlementFeeAmount: orderInfo.remainingSettlementFeeAmount,
    cancelReason: 'USER_CANCELLED',
  });
  ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(statusMessage));

  return {
    outcome: 'CANCELLED',
    orderId: request.orderId,
    remainingAmount: orderInfo.remainingAmount,
  };
}

/**
 * Handle order cancellation messages (legacy fire-and-forget `orders.cancel`).
 *
 * Kept during the C1 transition for any publisher still on the old subject.
 * New cancels should use the request/reply path (`handleCancelOrderRequest`).
 *
 * @param ctx - Handler context
 * @param data - Raw message data
 */
export function handleCancelOrder(ctx: HandlerContext, data: Uint8Array): void {
  try {
    // Parse and validate the cancellation request
    const request = parseMessage(data, cancelOrderMessageSchema);

    log.debug(
      { orderId: request.orderId, walletAddress: request.walletAddress },
      'processing cancel request'
    );

    const reply = computeCancelOutcome(ctx, request);

    if (reply.outcome === 'CANCELLED') {
      log.info({ orderId: request.orderId }, 'order cancelled successfully');
    } else if (reply.outcome === 'NOT_FOUND') {
      log.warn({ orderId: request.orderId }, 'order not found for cancellation');
      publishError(
        ctx,
        createErrorMessage(
          ERROR_CODES.ORDER_NOT_FOUND,
          `Order ${request.orderId} not found`,
          request.orderId
        )
      );
    } else {
      log.warn({ orderId: request.orderId }, 'wallet address mismatch for cancel request');
      publishError(
        ctx,
        createErrorMessage(
          ERROR_CODES.VALIDATION_ERROR,
          `Wallet address does not match order owner`,
          request.orderId
        )
      );
    }
  } catch (error) {
    log.error({ err: error }, 'error handling cancel order');
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    publishError(ctx, createErrorMessage(ERROR_CODES.INVALID_ORDER, errorMsg));
  }
}

/**
 * Handle order cancellation requests on the request/reply `orders.cancel.request`
 * subject (C1 engine-coordinated cancel).
 *
 * Computes the authoritative outcome and replies it to the requester, which
 * persists CANCELLED only on a `CANCELLED` reply. If the message can't be parsed
 * we deliberately do not reply — the requester's timeout then surfaces as a
 * "service unavailable" rather than a spurious cancel.
 *
 * @param ctx - Handler context
 * @param msg - Full NATS message (carries the reply subject)
 */
export function handleCancelOrderRequest(ctx: HandlerContext, msg: Msg): void {
  let request: CancelOrderMessage;
  try {
    request = parseMessage(msg.data, cancelOrderMessageSchema);
  } catch (error) {
    // Can't trust the orderId, so we can't form a valid reply — let the
    // requester time out (→ rejects the cancel) instead of guessing.
    log.error({ err: error }, 'error parsing cancel request');
    return;
  }

  try {
    log.debug(
      { orderId: request.orderId, walletAddress: request.walletAddress },
      'processing cancel request (request/reply)'
    );

    const reply = computeCancelOutcome(ctx, request);

    if (reply.outcome === 'CANCELLED') {
      log.info({ orderId: request.orderId }, 'order cancelled successfully (request/reply)');
    } else {
      log.warn({ orderId: request.orderId, outcome: reply.outcome }, 'cancel request not actioned');
    }

    if (msg.reply) {
      msg.respond(JSON.stringify(reply));
    } else {
      log.warn({ orderId: request.orderId }, 'cancel request has no reply subject');
    }
  } catch (error) {
    // Internal error after a valid parse — do not reply so the requester rejects
    // the cancel on timeout rather than receiving a malformed/partial verdict.
    log.error({ err: error, orderId: request.orderId }, 'error handling cancel request');
  }
}

export function handleUpdateOrder(ctx: HandlerContext, data: Uint8Array): void {
  try {
    // Parse and validate the update request
    const request = parseMessage(data, updateOrderMessageSchema);

    log.debug({ orderId: request.orderId }, 'processing update request');

    // Get order info before update (needed for status message)
    const orderInfo = ctx.engine.getOrderInfo(request.orderId);
    if (!orderInfo) {
      log.warn({ orderId: request.orderId }, 'order not found for update');
      publishError(
        ctx,
        createErrorMessage(
          ERROR_CODES.ORDER_NOT_FOUND,
          `Order ${request.orderId} not found`,
          request.orderId
        )
      );
      return;
    }

    // Update order in matching engine (removes old order from book)
    const oldOrder = ctx.engine.updateOrder(request.orderId, request.walletAddress);

    if (typeof oldOrder === 'object') {
      log.debug({ orderId: request.orderId }, 'order deactivated for update');

      const targetQuantity = request.originalAmount || request.quantity || request.amount;
      const targetSettlementFee = request.settlementFeeAmount || request.settlementFee;

      // Calculate new amounts
      let newOriginalAmount = oldOrder.originalAmount;
      let newRemainingAmount = oldOrder.remainingAmount;
      let newSettlementFeeAmount = oldOrder.settlementFeeAmount;
      let newRemainingSettlementFeeAmount =
        oldOrder.remainingSettlementFeeAmount ?? oldOrder.settlementFeeAmount;

      if (targetQuantity) {
        const filledAmount = subtractBigNumbers(oldOrder.originalAmount, oldOrder.remainingAmount);
        newOriginalAmount = targetQuantity;

        // Ensure new total quantity is not less than already filled amount
        if (BigInt(targetQuantity) < BigInt(filledAmount)) {
          throw new Error('New total quantity cannot be less than already filled amount');
        }
        newRemainingAmount = subtractBigNumbers(targetQuantity, filledAmount);

        // Recalculate settlement fees pro-rata if amount changed but not explicitly provided
        if (!targetSettlementFee) {
          newSettlementFeeAmount = calculateProRataSettlementFee(
            oldOrder.settlementFeeAmount,
            newOriginalAmount,
            oldOrder.originalAmount
          );
          newRemainingSettlementFeeAmount = calculateProRataSettlementFee(
            newSettlementFeeAmount,
            newRemainingAmount,
            newOriginalAmount
          );
        }
      }

      if (targetSettlementFee) {
        newSettlementFeeAmount = targetSettlementFee;
        // Recalculate remaining fee pro-rata based on new total fee
        newRemainingSettlementFeeAmount = calculateProRataSettlementFee(
          newSettlementFeeAmount,
          newRemainingAmount,
          newOriginalAmount
        );
      }

      const oldRate = isLimitOrder(oldOrder) ? oldOrder.rate : undefined;
      const newRate = request.rate ?? oldRate;

      // Construct updated order (keeping same ID).
      // We must rebuild via the base fields and re-assign rate only for limit orders,
      // because the Order union discriminates on rate (undefined for market, number for limit).
      const baseUpdate = {
        ...oldOrder,
        originalAmount: newOriginalAmount,
        remainingAmount: newRemainingAmount,
        settlementFeeAmount: newSettlementFeeAmount,
        remainingSettlementFeeAmount: newRemainingSettlementFeeAmount,
        timestamp: request.timestamp,
      };

      const updatedOrder: Order = isLimitOrder(oldOrder)
        ? ({ ...baseUpdate, rate: newRate ?? oldOrder.rate } as typeof oldOrder)
        : (baseUpdate as Order);

      // Re-submit to the matching engine
      const updateResult = ctx.engine.submitOrder(updatedOrder);

      // Publish to orders.updated topic for parameter synchronization
      const updateEvent = {
        orderId: request.orderId,
        originalAmount: newOriginalAmount,
        remainingAmount: newRemainingAmount,
        rate: newRate ?? 0,
        settlementFeeAmount: newSettlementFeeAmount,
        remainingSettlementFeeAmount: newRemainingSettlementFeeAmount,
        timestamp: request.timestamp,
      };

      ctx.nc.publish(NATS_TOPICS.ORDERS_UPDATED, JSON.stringify(updateEvent));

      log.debug(
        {
          orderId: request.orderId,
          oldRate,
          newRate,
          oldOriginalAmount: oldOrder.originalAmount,
          newOriginalAmount,
        },
        'order updated'
      );

      publishOrderStatusUpdates(ctx, request.orderId, updateResult, {
        originalAmount: newOriginalAmount,
        settlementFeeAmount: newSettlementFeeAmount,
        remainingSettlementFeeAmount: newRemainingSettlementFeeAmount,
        walletAddress: updatedOrder.walletAddress,
        assetId: updatedOrder.assetId,
        side: updatedOrder.side,
        type: updatedOrder.type,
        marketIds: updatedOrder.markets.map((m) => m.marketId),
      });

      if (updateResult.matches.length > 0) {
        publishMatchCreatedEvents(
          ctx,
          updatedOrder.assetId,
          updatedOrder.side,
          updateResult.matches
        );
      }

      log.debug(
        { orderId: request.orderId, matchCount: updateResult.matches.length },
        'order re-published'
      );
    } else {
      let errorCode: ErrorCode = ERROR_CODES.VALIDATION_ERROR;
      let errorMessage = 'Wallet address does not match order owner';

      if (oldOrder === 'NOT_FOUND') {
        errorCode = ERROR_CODES.ORDER_NOT_FOUND;
        errorMessage = `Order ${request.orderId} not found`;
      } else if (oldOrder === 'INVALID_STATUS') {
        errorCode = ERROR_CODES.INVALID_ORDER_STATUS;
        errorMessage = `Order ${request.orderId} is in a status that cannot be updated`;
      }

      log.warn({ orderId: request.orderId, errorMessage }, 'error handling update order');
      publishError(ctx, createErrorMessage(errorCode, errorMessage, request.orderId));
    }
  } catch (error) {
    log.error({ err: error }, 'error handling update order');
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    publishError(ctx, createErrorMessage(ERROR_CODES.INVALID_ORDER, errorMsg));
  }
}
