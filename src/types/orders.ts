import { z } from 'zod';

/**
 * Order side enum
 */
export enum OrderSide {
  Lend = 'LEND',
  Borrow = 'BORROW',
}

/**
 * Order status enum
 */
export enum OrderStatus {
  Open = 'OPEN',
  PartiallyFilled = 'PARTIALLY_FILLED',
  Filled = 'FILLED',
  Cancelled = 'CANCELLED',
}

/**
 * Order type enum
 */
export enum OrderType {
  Market = 'MARKET',
  Limit = 'LIMIT',
}

/**
 * Ethereum address validation schema
 *
 * Validates Ethereum addresses in the standard format (0x followed by
 * 40 hexadecimal characters), then normalizes to lowercase so that
 * case-variant inputs ("0xABC..." vs "0xabc...") compare equal in
 * downstream matching, indexing, and self-trade prevention.
 *
 * Audit reference: M-6 (case-sensitivity bug — same wallet in
 * mixed case could match against itself or be treated as two
 * distinct counterparties).
 */
export const ethereumAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format')
  .transform((s) => s.toLowerCase());

/**
 * Schema for a single market slot: a market UUID and its corresponding maturity timestamp.
 *
 * Orders specify which markets they participate in via an array of these slots.
 * Each entry must have both a valid market ID and a positive integer maturity.
 */
export const marketSlotSchema = z.object({
  marketId: z.string().uuid('Market ID must be a valid UUID'),
  maturity: z.number().int().positive('Maturity must be a positive integer'),
});

/**
 * TypeScript type for a market slot (marketId + maturity).
 */
export type MarketSlot = z.infer<typeof marketSlotSchema>;

/**
 * Base order schema with common fields.
 *
 * All monetary values are represented as decimal strings containing only digits.
 * This avoids precision issues when dealing with very large integers.
 * Markets are represented as an array of { marketId, maturity } slots; the array must be non-empty.
 */
const baseOrderSchema = z.object({
  orderId: z.string().uuid('Order ID must be a valid UUID'),
  walletAddress: ethereumAddressSchema, //@note : later change into account id
  loanToken: ethereumAddressSchema, //@note : later change into asset id
  assetId: z.string().uuid('Asset ID must be a valid UUID'),
  markets: z
    .array(marketSlotSchema)
    .min(1, 'At least one market slot is required'),
  timestamp: z.number().int().positive('Timestamp must be a positive integer'),
  side: z.nativeEnum(OrderSide),
  type: z.nativeEnum(OrderType),
  status: z.nativeEnum(OrderStatus).default(OrderStatus.Open),
  /**
   * Total notional amount for the order if it is fully filled.
   *
   * This value never changes over the lifetime of the order and is used as
   * the reference quantity for fee calculations.
   */
  originalAmount: z.string().regex(/^\d+$/, 'Amount must be a positive integer string'),
  /**
   * Remaining unfilled notional amount for the order.
   *
   * This value is decremented as matches execute against the order. When it
   * reaches zero, the order is considered fully filled and removed from the
   * book.
   */
  remainingAmount: z.string().regex(/^\d+$/, 'Amount must be a positive integer string'),
  /**
   * Total settlement fee for this order assuming it is fully filled.
   *
   * External clients specify this value when submitting the order. Internally,
   * the engine will allocate pro‑rata settlement fees for each match based on
   * the matched amount versus the original amount.
   */
  settlementFeeAmount: z.string().regex(/^\d+$/, 'Fee amount must be a positive integer string'),
  /**
   * Remaining settlement fee pool for this order.
   *
   * This is an internal field; external clients only provide settlementFeeAmount.
   * It is initialized from settlementFeeAmount when the order is first ingested
   * and then decremented as matches are executed.
   */
  remainingSettlementFeeAmount: z
    .string()
    .regex(/^\d+$/, 'Fee amount must be a positive integer string')
    .optional(),
});

/**
 * Lend Market Order schema
 */
export const lendMarketOrderSchema = baseOrderSchema.extend({
  side: z.literal(OrderSide.Lend),
  type: z.literal(OrderType.Market),
  rate: z.undefined().optional(),
});

/**
 * Lend Limit Order schema
 * Interest rate in basis points (1% = 100 bp)
 */
export const lendLimitOrderSchema = baseOrderSchema.extend({
  side: z.literal(OrderSide.Lend),
  type: z.literal(OrderType.Limit),
  rate: z
    .number()
    .int('Rate must be an integer')
    .min(0, 'Rate must be non-negative')
    .max(10000, 'Rate must not exceed 10000 basis points (100%)'),
});

/**
 * Borrow Market Order schema
 */
export const borrowMarketOrderSchema = baseOrderSchema.extend({
  side: z.literal(OrderSide.Borrow),
  type: z.literal(OrderType.Market),
  rate: z.undefined().optional()
});

/**
 * Borrow Limit Order schema
 * Interest rate in basis points (1% = 100 bp)
 */
export const borrowLimitOrderSchema = baseOrderSchema.extend({
  side: z.literal(OrderSide.Borrow),
  type: z.literal(OrderType.Limit),
  rate: z
    .number()
    .int('Rate must be an integer')
    .min(0, 'Rate must be non-negative')
    .max(10000, 'Rate must not exceed 10000 basis points (100%)')
});

/**
 * Union schema for all order types
 * Using regular union instead of discriminatedUnion because both lend and borrow
 * orders can have the same side value but different types
 */
export const orderSchema = z.union([
  lendMarketOrderSchema,
  lendLimitOrderSchema,
  borrowMarketOrderSchema,
  borrowLimitOrderSchema,
]);

/**
 * TypeScript types inferred from Zod schemas
 */
export type LendMarketOrder = z.infer<typeof lendMarketOrderSchema>;
export type LendLimitOrder = z.infer<typeof lendLimitOrderSchema>;
export type BorrowMarketOrder = z.infer<typeof borrowMarketOrderSchema>;
export type BorrowLimitOrder = z.infer<typeof borrowLimitOrderSchema>;
export type Order = z.infer<typeof orderSchema>;

/**
 * Type guard to check if order is a lend order
 */
export function isLendOrder(order: Order): order is LendMarketOrder | LendLimitOrder {
  return order.side === OrderSide.Lend;
}

/**
 * Type guard to check if order is a borrow order
 */
export function isBorrowOrder(order: Order): order is BorrowMarketOrder | BorrowLimitOrder {
  return order.side === OrderSide.Borrow;
}

/**
 * Type guard to check if order is a market order
 */
export function isMarketOrder(order: Order): order is LendMarketOrder | BorrowMarketOrder {
  return order.type === OrderType.Market;
}

/**
 * Type guard to check if order is a limit order
 */
export function isLimitOrder(order: Order): order is LendLimitOrder | BorrowLimitOrder {
  return order.type === OrderType.Limit;
}

/**
 * Order metadata for internal tracking.
 *
 * Uses the same markets array as the order for consistent lookups and iteration.
 */
export interface OrderMetadata {
  orderId: string;
  walletAddress: string;
  loanToken: string;
  markets: MarketSlot[];
  side: OrderSide;
  type: OrderType;
}

