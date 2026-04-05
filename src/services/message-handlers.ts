/**
 * NATS Message Handlers
 *
 * Implements handler functions for processing NATS messages and interacting
 * with the matching engine.
 */

import type { NatsConnection } from 'nats';
import type { MatchingEngine } from '../core/matching-engine';
import {
  lendMarketOrderSchema,
  lendLimitOrderSchema,
  borrowMarketOrderSchema,
  borrowLimitOrderSchema,
} from '../types/orders';
import type { Order } from '../types/orders';
import {
  cancelOrderMessageSchema,
  createErrorMessage,
  createOrderStatusMessage,
  ERROR_CODES,
  type ErrorMessage,
  type CancelledRemainderMessage,
} from '../types/messages';
import type { Match, MatchResult } from '../types/matches';
import { OrderSide, OrderStatus, OrderType } from '../types/orders';
import { NATS_TOPICS } from '../config/nats-config';
import { addBigNumbers, subtractBigNumbers, isZero, generateOrderId } from '../utils/helpers';
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

    log.debug({ orderId: order.orderId, matchCount: result.matches.length, type: label }, 'order processed');
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
 * Handle order cancellation messages
 *
 * @param ctx - Handler context
 * @param data - Raw message data
 */
export function handleCancelOrder(ctx: HandlerContext, data: Uint8Array): void {
  try {
    // Parse and validate the cancellation request
    const request = parseMessage(data, cancelOrderMessageSchema);

    log.debug({ orderId: request.orderId, walletAddress: request.walletAddress }, 'processing cancel request');

    // Get order info before cancellation (needed for status message)
    const orderInfo = ctx.engine.getOrderInfo(request.orderId);
    if (!orderInfo) {
      log.warn({ orderId: request.orderId }, 'order not found for cancellation');
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

    // Cancel order in matching engine
    const success = ctx.engine.cancelOrder(request.orderId, request.walletAddress);

    if (success) {
      log.info({ orderId: request.orderId }, 'order cancelled successfully');

      // Publish status update with filled amounts
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
