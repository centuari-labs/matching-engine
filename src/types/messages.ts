/**
 * NATS Message Types and Schemas
 *
 * Defines Zod schemas for validating NATS messages exchanged between
 * the backend service and the matching engine service.
 */

import { z } from 'zod';
import { matchSchema } from './matches';
import type { MatchResult } from './matches';
import { bytes32HexSchema, ethereumAddressSchema, OrderSide, OrderType } from './orders';

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

const digitStringSchema = z
  .string()
  .regex(/^\d+$/, 'Amount must be a positive integer string')
  .optional();

export const updateOrderMessageSchema = z
  .object({
    orderId: z.string().uuid(),
    walletAddress: ethereumAddressSchema,
    amount: digitStringSchema,
    quantity: digitStringSchema,
    originalAmount: digitStringSchema,
    rate: z.number().int().positive().optional(),
    settlementFee: digitStringSchema,
    settlementFeeAmount: digitStringSchema,
    timestamp: z
      .number()
      .int()
      .positive()
      .default(() => Date.now()),
  })
  .refine(
    (obj) =>
      obj.amount ||
      obj.quantity ||
      obj.originalAmount ||
      obj.rate ||
      obj.settlementFee ||
      obj.settlementFeeAmount,
    {
      message:
        'At least one update field (amount, quantity, originalAmount, rate, settlementFee, or settlementFeeAmount) must be provided',
    }
  );

/**
 * Type for order update messages
 */
export type UpdateOrderMessage = z.infer<typeof updateOrderMessageSchema>;

/**
 * Zod schema for the OrderUpdatedMessage published to `orders.updated` topic.
 */
export const orderUpdatedMessageSchema = z.object({
  orderId: z.string().uuid(),
  originalAmount: z.string(),
  remainingAmount: z.string(),
  rate: z.number().int().positive(),
  settlementFeeAmount: z.string(),
  remainingSettlementFeeAmount: z.string(),
  timestamp: z.number().int().positive(),
});

export type OrderUpdatedMessage = z.infer<typeof orderUpdatedMessageSchema>;

/**
 * Type for order cancellation messages
 */
export type CancelOrderMessage = z.infer<typeof cancelOrderMessageSchema>;

/**
 * Authoritative reply the engine sends back on the `orders.cancel.request`
 * request/reply subject (C1 engine-coordinated cancel). The requester (backend)
 * persists CANCELLED only on a `CANCELLED` outcome.
 *
 * Outcomes the engine can actually distinguish from its order book:
 * - `CANCELLED`  — order was resting (OPEN/PARTIALLY_FILLED), owner matched, removed.
 * - `NOT_OWNER`  — order is in the book but the wallet does not own it.
 * - `NOT_FOUND`  — order is not in the book. This covers both "never existed" and
 *                  "already fully matched and removed" — the engine cannot tell them
 *                  apart, because filled orders leave the book. The backend only sends
 *                  a request for an order its DB still shows OPEN/PARTIALLY_FILLED, so
 *                  in practice NOT_FOUND means the order was matched in the race window.
 */
export const cancelReplySchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('CANCELLED'),
    orderId: z.string().uuid(),
    remainingAmount: z.string(),
  }),
  z.object({
    outcome: z.literal('NOT_OWNER'),
    orderId: z.string().uuid(),
  }),
  z.object({
    outcome: z.literal('NOT_FOUND'),
    orderId: z.string().uuid(),
  }),
]);

/**
 * Type for cancel request replies
 */
export type CancelReply = z.infer<typeof cancelReplySchema>;

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
  matches: z.array(matchSchema),

  /**
   * Remaining order if partially filled, null if fully filled
   */
  remainingOrder: z
    .object({
      orderId: z.string().uuid(),
      remainingAmount: z.string().regex(/^\d+$/, 'Amount must be a positive integer string'),
      status: z.string(),
    })
    .nullable(),

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
 *
 * Published by the matching engine and consumed by the DB Writer to
 * persist order state in the database. Filled amounts are always
 * computed at the source so consumers can use them directly.
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
   * Total filled quantity so far (originalAmount - remainingAmount)
   */
  filledQuantity: z.string(),

  /**
   * Total filled settlement fee so far
   */
  filledSettlementFeeAmount: z.string(),

  /**
   * Reason why the order was cancelled (only present when status is CANCELLED)
   */
  cancelReason: z.enum(['USER_CANCELLED', 'IOC']).optional(),

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
 * Schema for cancelled remainder orders.
 *
 * Published when a market order (IOC) is partially filled and the unmatched
 * remainder needs to be persisted as a separate CANCELLED order row so users
 * can see it in their transaction history.
 */
export const cancelledRemainderMessageSchema = z.object({
  /** New UUID for the cancelled remainder order */
  orderId: z.string().uuid(),
  /** ID of the original order that was partially filled */
  originalOrderId: z.string().uuid(),
  /** Wallet address of the order owner */
  accountWallet: ethereumAddressSchema,
  /** Asset UUID */
  assetId: z.string().uuid(),
  /** Order side */
  side: z.nativeEnum(OrderSide),
  /** Order type */
  type: z.nativeEnum(OrderType),
  /** Rate (0 for market orders) */
  rate: z.number(),
  /** Unmatched quantity */
  quantity: z.string().regex(/^\d+$/, 'Quantity must be a positive integer string'),
  /** Remaining settlement fee for the unmatched portion */
  settlementFee: z.string().regex(/^\d+$/, 'Settlement fee must be a positive integer string'),
  /** Market IDs (bytes32 hex) the order participated in */
  marketIds: z.array(bytes32HexSchema).min(1),
  /** Reason for cancellation */
  cancelReason: z.enum(['USER_CANCELLED', 'IOC']).optional(),
  /** Timestamp */
  timestamp: z.number().int().positive(),
});

/**
 * Type for cancelled remainder messages
 */
export type CancelledRemainderMessage = z.infer<typeof cancelledRemainderMessageSchema>;

/**
 * Schema for individual order entries in an order book snapshot
 */
export const orderBookEntrySchema = z.object({
  orderId: z.string().uuid(),
  rate: z.number().int().min(0).max(10000).optional(),
  amount: z.string().regex(/^\d+$/, 'Amount must be a positive integer string'),
  timestamp: z.number().int().positive(),
});

/**
 * Schema for order book snapshot responses
 */
export const orderBookSnapshotMessageSchema = z.object({
  /**
   * Lend orders grouped by token and maturity
   */
  lendOrders: z.record(z.string(), z.record(z.string(), z.array(orderBookEntrySchema))),

  /**
   * Borrow orders grouped by token and maturity
   */
  borrowOrders: z.record(z.string(), z.record(z.string(), z.array(orderBookEntrySchema))),

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
export type OrderBookSnapshotMessage = z.infer<typeof orderBookSnapshotMessageSchema>;

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
  details: z.record(z.string(), z.unknown()).optional(),
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
  INVALID_ORDER_STATUS: 'INVALID_ORDER_STATUS',
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
export function createMatchCreatedMessage(
  orderId: string,
  result: MatchResult
): MatchCreatedMessage {
  return {
    orderId,
    matches: result.matches,
    remainingOrder: result.remainingOrder,
    timestamp: Date.now(),
  };
}

/**
 * Source shape for creating an order status message.
 *
 * This is intentionally minimal and satisfied by both full `Order` objects
 * and `AffectedOrder` instances produced by the matching engine.
 */
export interface OrderStatusSource {
  /** ID of the order */
  orderId: string;
  /** Current status of the order */
  status: string;
  /** Remaining unfilled amount */
  remainingAmount: string;
  /** Original notional amount for the order */
  originalAmount: string;
  /** Total settlement fee amount assuming full fill */
  settlementFeeAmount: string;
  /** Remaining settlement fee pool (may be lazily initialized) */
  remainingSettlementFeeAmount?: string;
  /** Reason for cancellation (only when status is CANCELLED) */
  cancelReason?: 'USER_CANCELLED' | 'IOC';
}

/**
 * Create an order status message from a unified order-like source.
 *
 * @param source - Order-like object containing the fields needed to derive status.
 * @returns Formatted order status message
 */
export function createOrderStatusMessage(source: OrderStatusSource): OrderStatusMessage {
  const {
    orderId,
    status,
    remainingAmount,
    originalAmount,
    settlementFeeAmount,
    remainingSettlementFeeAmount,
    cancelReason,
  } = source;

  const filledQuantity =
    originalAmount !== undefined
      ? (BigInt(originalAmount) - BigInt(remainingAmount)).toString()
      : '0';

  const filledSettlementFeeAmount =
    settlementFeeAmount !== undefined && remainingSettlementFeeAmount !== undefined
      ? (BigInt(settlementFeeAmount) - BigInt(remainingSettlementFeeAmount)).toString()
      : '0';

  return {
    orderId,
    status: status as OrderStatusMessage['status'],
    remainingAmount,
    filledQuantity,
    filledSettlementFeeAmount,
    ...(cancelReason ? { cancelReason } : {}),
    timestamp: Date.now(),
  };
}
