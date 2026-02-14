import { z } from 'zod';
import { ethereumAddressSchema } from './orders';
import type { OrderStatus } from './orders';

/**
 * Match schema representing a successful match between lend and borrow orders.
 *
 * A match is a single fill between one lend order and one borrow order. Large
 * orders may be filled by multiple matches over time.
 */
export const matchSchema = z.object({
  matchId: z.string().uuid('Match ID must be a valid UUID'),
  lendOrderId: z.string().uuid('Lend order ID must be a valid UUID'), //@todo : change into order market id
  borrowOrderId: z.string().uuid('Borrow order ID must be a valid UUID'), //@todo : change into order market id
  lenderWallet: ethereumAddressSchema, //@todo : change into account id
  borrowerWallet: ethereumAddressSchema, //@todo : change into account id
  matchedAmount: z.string().regex(/^\d+$/, 'Matched amount must be a positive integer string'),
  rate: z
    .number()
    .int('Rate must be an integer')
    .min(0, 'Rate must be non-negative')
    .max(10000, 'Rate must not exceed 10000 basis points (100%)'),
  loanToken: ethereumAddressSchema, //@todo : change into asset id
  maturity: z.number().int().positive('Maturity must be a positive integer'),
  timestamp: z.number().int().positive('Timestamp must be a positive integer'),
  borrowerIsTaker: z.boolean(),
  /**
   * Maker fee charged on this match.
   *
   * This is typically a small percentage of matchedAmount, computed using
   * maker‑fee specific logic in the matching engine.
   */
  makerFeeAmount: z.string().regex(/^\d+$/, 'Maker fee amount must be a positive integer string'),
  /**
   * Taker fee charged on this match.
   *
   * This is typically larger than the maker fee and is also expressed as a
   * percentage of matchedAmount.
   */
  takerFeeAmount: z.string().regex(/^\d+$/, 'Taker fee amount must be a positive integer string'),
  /**
   * Portion of the lender's order‑level settlementFeeAmount that is allocated
   * to this specific match.
   *
   * The matching/settlement logic computes this value using a pro‑rata
   * calculation based on the matched amount for the lend side.
   */
  lenderSettlementFeeAmount: z
    .string()
    .regex(/^\d+$/, 'Lender settlement fee amount must be a positive integer string'),
  /**
   * Portion of the borrower's order‑level settlementFeeAmount that is allocated
   * to this specific match.
   *
   * The matching/settlement logic computes this value using a pro‑rata
   * calculation based on the matched amount for the borrow side.
   */
  borrowerSettlementFeeAmount: z
    .string()
    .regex(/^\d+$/, 'Borrower settlement fee amount must be a positive integer string'),
});

/**
 * TypeScript type inferred from match schema
 */
export type Match = z.infer<typeof matchSchema>;

/**
 * Represents an order affected by a match
 *
 * Contains the order's updated status and remaining amount after the match.
 */
export interface AffectedOrder {
  /** The order ID */
  orderId: string;
  /** The order's status after the match */
  status: OrderStatus;
  /** The order's remaining amount after the match */
  remainingAmount: string;
  /**
   * Total original notional amount for the order.
   *
   * Mirrors `Order.originalAmount` so downstream consumers can compute
   * filled quantities from status messages using only this structure.
   */
  originalAmount: string;
  /**
   * Total settlement fee amount for this order assuming it is fully filled.
   *
   * Mirrors `Order.settlementFeeAmount` for consistent status publishing.
   */
  settlementFeeAmount: string;
  /**
   * Remaining settlement fee pool for this order.
   *
   * Mirrors `Order.remainingSettlementFeeAmount` and is optional because
   * it may be lazily initialized in some flows.
   */
  remainingSettlementFeeAmount?: string;
}

/**
 * Match result returned after order submission
 */
export interface MatchResult {
  /** Array of matches created from this order */
  matches: Match[];
  /** Remaining order info if partially filled, null if fully filled or no matches */
  remainingOrder: {
    orderId: string;
    remainingAmount: string;
    status: string;
  } | null;
  /** Array of maker orders affected by the matching */
  affectedMakerOrders: AffectedOrder[];
}

/**
 * Order book snapshot for a specific token and maturity
 */
export interface OrderBookSnapshot {
  loanToken: string;
  maturity: number;
  lendOrders: Array<{
    orderId: string;
    rate?: number;
    amount: string;
    timestamp: number;
  }>;
  borrowOrders: Array<{
    orderId: string;
    rate?: number;
    amount: string;
    timestamp: number;
  }>;
}

