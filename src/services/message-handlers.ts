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
import {
  cancelOrderMessageSchema,
  updateOrderMessageSchema,
  createErrorMessage,
  createOrderStatusMessage,
  ERROR_CODES,
  type ErrorMessage,
  type CancelledRemainderMessage,
  type ErrorCode,
} from '../types/messages';
import type { Match, MatchResult } from '../types/matches';
import { OrderSide, OrderStatus, OrderType, type Order } from '../types/orders';
import { NATS_TOPICS } from '../config/nats-config';
import { addBigNumbers, subtractBigNumbers, isZero, generateOrderId } from '../utils/helpers';

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
    console.error('Failed to publish error message:', err);
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
          : originalOrder.remainingSettlementFeeAmount ?? '0',
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
        const remainingSettlementFee =
          originalOrder.remainingSettlementFeeAmount ?? '0';

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
          timestamp: Date.now(),
        };
        ctx.nc.publish(
          NATS_TOPICS.ORDERS_CANCELLED_REMAINDER,
          JSON.stringify(cancelledRemainder)
        );
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
      });
      ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(cancelMessage));
    }

    // Publish status updates for all affected maker orders
    for (const affectedOrder of result.affectedMakerOrders) {
      const statusMessage = createOrderStatusMessage(affectedOrder);
      ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(statusMessage));
    }
  } catch (err) {
    console.error('Failed to publish order status updates:', err);
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
    console.error('Failed to publish match created events:', err);
  }
}

/**
 * Handle lend market order messages
 *
 * @param ctx - Handler context
 * @param data - Raw message data
 */
export function handleLendMarketOrder(ctx: HandlerContext, data: Uint8Array): void {
  try {
    // Parse and validate the order
    const order = parseMessage(data, lendMarketOrderSchema);
    // Initialize remaining settlement fee pool for internal tracking
    (order as any).remainingSettlementFeeAmount = order.settlementFeeAmount;

    console.log(`Processing lend market order: ${order.orderId}`);

    // Submit to matching engine
    const result = ctx.engine.submitOrder(order);

    // Publish order status updates for taker and affected maker orders
    publishOrderStatusUpdates(ctx, order.orderId, result, {
      originalAmount: order.originalAmount,
      settlementFeeAmount: order.settlementFeeAmount,
      remainingSettlementFeeAmount: (order as any).remainingSettlementFeeAmount,
      walletAddress: order.walletAddress,
      assetId: order.assetId,
      side: order.side,
      type: order.type,
      marketIds: order.markets.map((m) => m.marketId),
    });

    // Publish recent-trade events for each match
    if (result.matches.length > 0) {
      publishMatchCreatedEvents(ctx, order.assetId, order.side, result.matches);
    }

    console.log(
      `Lend market order ${order.orderId} processed: ${result.matches.length} matches`
    );
  } catch (error) {
    console.error('Error handling lend market order:', error);
    const errorMsg =
      error instanceof Error ? error.message : 'Unknown error';
    publishError(
      ctx,
      createErrorMessage(ERROR_CODES.INVALID_ORDER, errorMsg)
    );
  }
}

/**
 * Handle lend limit order messages
 *
 * @param ctx - Handler context
 * @param data - Raw message data
 */
export function handleLendLimitOrder(ctx: HandlerContext, data: Uint8Array): void {
  try {
    // Parse and validate the order
    const order = parseMessage(data, lendLimitOrderSchema);
    // Initialize remaining settlement fee pool for internal tracking
    (order as any).remainingSettlementFeeAmount = order.settlementFeeAmount;

    console.log(`Processing lend limit order: ${order.orderId} at rate ${order.rate}`);

    // Submit to matching engine
    const result = ctx.engine.submitOrder(order);

    // Publish order status updates for taker and affected maker orders
    publishOrderStatusUpdates(ctx, order.orderId, result, {
      originalAmount: order.originalAmount,
      settlementFeeAmount: order.settlementFeeAmount,
      remainingSettlementFeeAmount: (order as any).remainingSettlementFeeAmount,
      walletAddress: order.walletAddress,
      assetId: order.assetId,
      side: order.side,
      type: order.type,
      marketIds: order.markets.map((m) => m.marketId),
    });

    // Publish recent-trade events for each match
    if (result.matches.length > 0) {
      publishMatchCreatedEvents(ctx, order.assetId, order.side, result.matches);
    }

    console.log(
      `Lend limit order ${order.orderId} processed: ${result.matches.length} matches`
    );
  } catch (error) {
    console.error('Error handling lend limit order:', error);
    const errorMsg =
      error instanceof Error ? error.message : 'Unknown error';
    publishError(
      ctx,
      createErrorMessage(ERROR_CODES.INVALID_ORDER, errorMsg)
    );
  }
}

/**
 * Handle borrow market order messages
 *
 * @param ctx - Handler context
 * @param data - Raw message data
 */
export function handleBorrowMarketOrder(ctx: HandlerContext, data: Uint8Array): void {
  try {
    // Parse and validate the order
    const order = parseMessage(data, borrowMarketOrderSchema);
    // Initialize remaining settlement fee pool for internal tracking
    (order as any).remainingSettlementFeeAmount = order.settlementFeeAmount;

    console.log(`Processing borrow market order: ${order.orderId}`);

    // Submit to matching engine
    const result = ctx.engine.submitOrder(order);

    // Publish order status updates for taker and affected maker orders
    publishOrderStatusUpdates(ctx, order.orderId, result, {
      originalAmount: order.originalAmount,
      settlementFeeAmount: order.settlementFeeAmount,
      remainingSettlementFeeAmount: (order as any).remainingSettlementFeeAmount,
      walletAddress: order.walletAddress,
      assetId: order.assetId,
      side: order.side,
      type: order.type,
      marketIds: order.markets.map((m) => m.marketId),
    });

    // Publish recent-trade events for each match
    if (result.matches.length > 0) {
      publishMatchCreatedEvents(ctx, order.assetId, order.side, result.matches);
    }

    console.log(
      `Borrow market order ${order.orderId} processed: ${result.matches.length} matches`
    );
  } catch (error) {
    console.error('Error handling borrow market order:', error);
    const errorMsg =
      error instanceof Error ? error.message : 'Unknown error';
    publishError(
      ctx,
      createErrorMessage(ERROR_CODES.INVALID_ORDER, errorMsg)
    );
  }
}

/**
 * Handle borrow limit order messages
 *
 * @param ctx - Handler context
 * @param data - Raw message data
 */
export function handleBorrowLimitOrder(ctx: HandlerContext, data: Uint8Array): void {
  try {
    // Parse and validate the order
    const order = parseMessage(data, borrowLimitOrderSchema);
    // Initialize remaining settlement fee pool for internal tracking
    (order as any).remainingSettlementFeeAmount = order.settlementFeeAmount;

    console.log(`Processing borrow limit order: ${order.orderId} at rate ${order.rate}`);

    // Submit to matching engine
    const result = ctx.engine.submitOrder(order);

    // Publish order status updates for taker and affected maker orders
    publishOrderStatusUpdates(ctx, order.orderId, result, {
      originalAmount: order.originalAmount,
      settlementFeeAmount: order.settlementFeeAmount,
      remainingSettlementFeeAmount: (order as any).remainingSettlementFeeAmount,
      walletAddress: order.walletAddress,
      assetId: order.assetId,
      side: order.side,
      type: order.type,
      marketIds: order.markets.map((m) => m.marketId),
    });

    // Publish recent-trade events for each match
    if (result.matches.length > 0) {
      publishMatchCreatedEvents(ctx, order.assetId, order.side, result.matches);
    }

    console.log(
      `Borrow limit order ${order.orderId} processed: ${result.matches.length} matches`
    );
  } catch (error) {
    console.error('Error handling borrow limit order:', error);
    const errorMsg =
      error instanceof Error ? error.message : 'Unknown error';
    publishError(
      ctx,
      createErrorMessage(ERROR_CODES.INVALID_ORDER, errorMsg)
    );
  }
}

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

    console.log(`Processing cancel request for order: ${request.orderId} from wallet: ${request.walletAddress}`);

    // Get order info before cancellation (needed for status message)
    const orderInfo = ctx.engine.getOrderInfo(request.orderId);
    if (!orderInfo) {
      console.warn(`Order ${request.orderId} not found for cancellation`);
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
      console.log(`Order ${request.orderId} cancelled successfully`);

      // Publish status update with filled amounts
      const statusMessage = createOrderStatusMessage({
        orderId: request.orderId,
        status: 'CANCELLED',
        remainingAmount: orderInfo.remainingAmount,
        originalAmount: orderInfo.originalAmount,
        settlementFeeAmount: orderInfo.settlementFeeAmount,
        remainingSettlementFeeAmount: orderInfo.remainingSettlementFeeAmount,
      });
      ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(statusMessage));
    } else {
      console.warn(`Wallet address mismatch for order ${request.orderId}`);
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
    console.error('Error handling cancel order:', error);
    const errorMsg =
      error instanceof Error ? error.message : 'Unknown error';
    publishError(
      ctx,
      createErrorMessage(ERROR_CODES.INVALID_ORDER, errorMsg)
    );
  }
}

export function handleUpdateOrder(ctx: HandlerContext, data: Uint8Array): void {
  try {
    // Parse and validate the update request
    const request = parseMessage(data, updateOrderMessageSchema);

    console.log(`Processing update request for order: ${request.orderId}`);

    // Get order info before update (needed for status message)
    const orderInfo = ctx.engine.getOrderInfo(request.orderId);
    if (!orderInfo) {
      console.warn(`Order ${request.orderId} not found for update`);
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
      console.log(`Order ${request.orderId} deactivated for update`);

      const targetQuantity = request.originalAmount || request.quantity || request.amount;
      const targetSettlementFee = request.settlementFeeAmount || request.settlementFee;

      // Calculate new amounts
      let newOriginalAmount = oldOrder.originalAmount;
      let newRemainingAmount = oldOrder.remainingAmount;
      let newSettlementFeeAmount = oldOrder.settlementFeeAmount;
      let newRemainingSettlementFeeAmount = oldOrder.remainingSettlementFeeAmount ?? oldOrder.settlementFeeAmount;

      if (targetQuantity) {
        const filledAmount = subtractBigNumbers(oldOrder.originalAmount, oldOrder.remainingAmount);
        newOriginalAmount = targetQuantity;
        newRemainingAmount = subtractBigNumbers(targetQuantity, filledAmount);

        // Ensure remaining amount is not negative
        if (BigInt(newRemainingAmount) < 0n) {
          throw new Error('New total quantity cannot be less than already filled amount');
        }

        // Recalculate settlement fees pro-rata if amount changed but not explicitly provided
        if (!targetSettlementFee) {
          const oldTotal = BigInt(oldOrder.originalAmount);
          const newTotal = BigInt(newOriginalAmount);
          newSettlementFeeAmount = ((BigInt(oldOrder.settlementFeeAmount) * newTotal) / oldTotal).toString();

          const remaining = BigInt(newRemainingAmount);
          newRemainingSettlementFeeAmount = ((BigInt(newSettlementFeeAmount) * remaining) / newTotal).toString();
        }
      }

      if (targetSettlementFee) {
        newSettlementFeeAmount = targetSettlementFee;
        // Recalculate remaining fee pro-rata based on new total fee
        const total = BigInt(newOriginalAmount);
        const remaining = BigInt(newRemainingAmount);
        newRemainingSettlementFeeAmount = ((BigInt(newSettlementFeeAmount) * remaining) / total).toString();
      }

      const newRate = request.rate ?? (oldOrder as any).rate;

      // Construct updated order (keeping same ID)
      const updatedOrder = {
        ...oldOrder,
        originalAmount: newOriginalAmount,
        remainingAmount: newRemainingAmount,
        rate: newRate,
        settlementFeeAmount: newSettlementFeeAmount,
        remainingSettlementFeeAmount: newRemainingSettlementFeeAmount,
        timestamp: request.timestamp,
      } as Order;

      // Re-submit to the matching engine
      const updateResult = ctx.engine.submitOrder(updatedOrder);

      // Publish to orders.updated topic for parameter synchronization
      const updateEvent = {
        orderId: request.orderId,
        originalAmount: newOriginalAmount,
        remainingAmount: newRemainingAmount,
        rate: newRate,
        settlementFeeAmount: newSettlementFeeAmount,
        remainingSettlementFeeAmount: newRemainingSettlementFeeAmount,
        timestamp: request.timestamp,
      };

      ctx.nc.publish(NATS_TOPICS.ORDERS_UPDATED, JSON.stringify(updateEvent));

      const oldRate = (oldOrder as any).rate;
      const oldOriginalAmount = oldOrder.originalAmount;

      console.log(`Order ${request.orderId} updated: [Rate: ${oldRate} -> ${newRate}], [Quantity: ${oldOriginalAmount} -> ${newOriginalAmount}]`);

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
        publishMatchCreatedEvents(ctx, updatedOrder.assetId, updatedOrder.side, updateResult.matches);
      }

      console.log(`Order ${request.orderId} re-published: ${updateResult.matches.length} matches found after update`);
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

      console.warn(`${errorMessage} for order ${request.orderId}`);
      publishError(
        ctx,
        createErrorMessage(
          errorCode as any,
          errorMessage,
          request.orderId
        )
      );
    }
  } catch (error) {
    console.error('Error handling update order:', error);
    const errorMsg =
      error instanceof Error ? error.message : 'Unknown error';
    publishError(
      ctx,
      createErrorMessage(ERROR_CODES.INVALID_ORDER, errorMsg)
    );
  }
}