/**
 * NATS Message Types and Schemas
 *
 * Defines Zod schemas for validating NATS messages exchanged between
 * the backend service and the matching engine service.
 */

import { z } from 'zod';
import type { MatchResult } from './matches';
import type { Order } from './orders';
import { ethereumAddressSchema } from './orders';

/**
 * Schema for order cancellation requests
 */
export const cancelOrderMessageSchema = z.object({
  /**
   * ID of the order to cancel
   */
  orderId: z.string().uuid(),

  /**
   * Wallet address of the order owner
   */
  walletAddress: ethereumAddressSchema,

  /**
   * Timestamp of the cancellation request
   */
  timestamp: z.number().int().positive(),
});

/**
 * Type for order cancellation messages
 */
export type CancelOrderMessage = z.infer<typeof cancelOrderMessageSchema>;

/**
 * Schema for match creation notifications
 *
 * Published when orders are matched successfully.
 */
export const matchCreatedMessageSchema = z.object({
  /**
   * ID of the order that was submitted
   */
  orderId: z.string().uuid(),

  /**
   * Array of matches created from this order
   */
  matches: z.array(z.any()), // Using any here since Match type is complex

  /**
   * Remaining order if partially filled, null if fully filled
   */
  remainingOrder: z.any().nullable(),

  /**
   * Timestamp when matches were created
   */
  timestamp: z.number().int().positive(),
});

/**
 * Type for match creation messages
 */
export type MatchCreatedMessage = z.infer<typeof matchCreatedMessageSchema>;

/**
 * Schema for order status update notifications
 */
export const orderStatusMessageSchema = z.object({
  /**
   * ID of the order
   */
  orderId: z.string().uuid(),

  /**
   * Current status of the order
   */
  status: z.enum(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED']),

  /**
   * Remaining amount in the order
   */
  remainingAmount: z.string(),

  /**
   * Timestamp of the status update
   */
  timestamp: z.number().int().positive(),
});

/**
 * Type for order status messages
 */
export type OrderStatusMessage = z.infer<typeof orderStatusMessageSchema>;

/**
 * Schema for order book snapshot responses
 */
export const orderBookSnapshotMessageSchema = z.object({
  /**
   * Lend orders grouped by token and maturity
   */
  lendOrders: z.record(z.string(), z.record(z.string(), z.array(z.any()))),

  /**
   * Borrow orders grouped by token and maturity
   */
  borrowOrders: z.record(z.string(), z.record(z.string(), z.array(z.any()))),

  /**
   * Timestamp of the snapshot
   */
  timestamp: z.number().int().positive(),

  /**
   * Total number of active orders
   */
  totalOrders: z.number().int().nonnegative(),
});

/**
 * Type for order book snapshot messages
 */
export type OrderBookSnapshotMessage = z.infer<
  typeof orderBookSnapshotMessageSchema
>;

/**
 * Schema for error notifications
 */
export const errorMessageSchema = z.object({
  /**
   * Error indicator
   */
  error: z.literal(true),

  /**
   * Error code for categorization
   */
  code: z.string(),

  /**
   * Human-readable error message
   */
  message: z.string(),

  /**
   * Optional order ID if error is related to a specific order
   */
  orderId: z.string().uuid().optional(),

  /**
   * Timestamp when error occurred
   */
  timestamp: z.number().int().positive(),

  /**
   * Optional additional error details
   */
  details: z.record(z.any()).optional(),
});

/**
 * Type for error messages
 */
export type ErrorMessage = z.infer<typeof errorMessageSchema>;

/**
 * Error codes used in error messages
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_ORDER: 'INVALID_ORDER',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  RATE_MISMATCH: 'RATE_MISMATCH',
  INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NATS_CONNECTION_ERROR: 'NATS_CONNECTION_ERROR',
  MESSAGE_PARSE_ERROR: 'MESSAGE_PARSE_ERROR',
} as const;

/**
 * Type for error code keys
 */
export type ErrorCodeKey = keyof typeof ERROR_CODES;

/**
 * Type for error code values
 */
export type ErrorCode = (typeof ERROR_CODES)[ErrorCodeKey];

/**
 * Create a standardized error message
 *
 * @param code - Error code
 * @param message - Error message
 * @param orderId - Optional order ID
 * @param details - Optional additional details
 * @returns Formatted error message object
 */
export function createErrorMessage(
  code: ErrorCode,
  message: string,
  orderId?: string,
  details?: Record<string, unknown>
): ErrorMessage {
  return {
    error: true,
    code,
    message,
    orderId,
    timestamp: Date.now(),
    details,
  };
}

/**
 * Create a match created message from a match result
 *
 * @param orderId - ID of the order that was submitted
 * @param result - Match result from the matching engine
 * @returns Formatted match created message
 */
export function createMatchCreatedMessage(orderId: string, result: MatchResult): MatchCreatedMessage {
  return {
    orderId,
    matches: result.matches,
    remainingOrder: result.remainingOrder,
    timestamp: Date.now(),
  };
}

/**
 * Create an order status message
 *
 * @param order - Order object
 * @returns Formatted order status message
 */
export function createOrderStatusMessage(order: Order): OrderStatusMessage {
  return {
    orderId: order.orderId,
    status: order.status,
    remainingAmount: order.remainingAmount.toString(),
    timestamp: Date.now(),
  };
}

