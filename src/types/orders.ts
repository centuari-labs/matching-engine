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
 */
const ethereumAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

/**
 * Base order schema with common fields
 */
const baseOrderSchema = z.object({
  orderId: z.string().uuid('Order ID must be a valid UUID'),
  loanToken: ethereumAddressSchema,
  maturities: z
    .array(z.number().int().positive('Maturity must be a positive integer'))
    .min(1, 'At least one maturity date is required'),
  timestamp: z.number().int().positive('Timestamp must be a positive integer'),
  side: z.nativeEnum(OrderSide),
  type: z.nativeEnum(OrderType),
  status: z.nativeEnum(OrderStatus).default(OrderStatus.Open),
  originalAmount: z.string().regex(/^\d+$/, 'Amount must be a positive integer string'),
  remainingAmount: z.string().regex(/^\d+$/, 'Amount must be a positive integer string'),
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
    .max(100000, 'Rate must not exceed 100000 basis points (1000%)'),
});

/**
 * Borrow Market Order schema
 */
export const borrowMarketOrderSchema = baseOrderSchema.extend({
  side: z.literal(OrderSide.Borrow),
  type: z.literal(OrderType.Market),
  rate: z.undefined().optional(),
  collateralTokens: z
    .array(ethereumAddressSchema)
    .min(1, 'At least one collateral token is required'),
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
    .max(100000, 'Rate must not exceed 100000 basis points (1000%)'),
  collateralTokens: z
    .array(ethereumAddressSchema)
    .min(1, 'At least one collateral token is required'),
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
 * Order metadata for internal tracking
 */
export interface OrderMetadata {
  orderId: string;
  loanToken: string;
  maturities: number[];
  side: OrderSide;
  type: OrderType;
}

