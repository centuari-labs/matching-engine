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
  createErrorMessage,
  createOrderStatusMessage,
  ERROR_CODES,
  type ErrorMessage,
} from '../types/messages';
import type { MatchResult } from '../types/matches';
import { OrderStatus } from '../types/orders';
import { NATS_TOPICS } from '../config/nats-config';

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
function publishOrderStatusUpdates(
  ctx: HandlerContext,
  orderId: string,
  result: MatchResult
): void {
  try {
    // Publish taker order status
    if (result.remainingOrder) {
      // Order is partially filled or still open
      const takerStatusMessage = {
        orderId: result.remainingOrder.orderId,
        status: result.remainingOrder.status,
        remainingAmount: result.remainingOrder.remainingAmount,
        timestamp: Date.now(),
      };
      ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(takerStatusMessage));
    } else if (result.matches.length > 0) {
      // Order was fully filled (no remaining order means it was completely matched)
      const takerStatusMessage = {
        orderId,
        status: OrderStatus.Filled,
        remainingAmount: '0',
        timestamp: Date.now(),
      };
      ctx.nc.publish(NATS_TOPICS.ORDERS_STATUS, JSON.stringify(takerStatusMessage));
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
    publishOrderStatusUpdates(ctx, order.orderId, result);

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
    publishOrderStatusUpdates(ctx, order.orderId, result);

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
    publishOrderStatusUpdates(ctx, order.orderId, result);

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
    publishOrderStatusUpdates(ctx, order.orderId, result);

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

    // Check if order exists first
    if (!ctx.engine.hasOrder(request.orderId)) {
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
      
      // Publish status update
      ctx.nc.publish(
        NATS_TOPICS.ORDERS_STATUS,
        JSON.stringify({
          orderId: request.orderId,
          status: 'CANCELLED',
          timestamp: Date.now(),
        })
      );
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

