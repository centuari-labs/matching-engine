import { z } from 'zod';
import { ethereumAddressSchema } from './orders';

/**
 * Match schema representing a successful match between lend and borrow orders
 */
export const matchSchema = z.object({
  matchId: z.string().uuid('Match ID must be a valid UUID'),
  lendOrderId: z.string().uuid('Lend order ID must be a valid UUID'),
  borrowOrderId: z.string().uuid('Borrow order ID must be a valid UUID'),
  lenderWallet: ethereumAddressSchema,
  borrowerWallet: ethereumAddressSchema,
  matchedAmount: z.string().regex(/^\d+$/, 'Matched amount must be a positive integer string'),
  rate: z
    .number()
    .int('Rate must be an integer')
    .min(0, 'Rate must be non-negative')
    .max(100000, 'Rate must not exceed 100000 basis points (1000%)'),
  loanToken: ethereumAddressSchema,
  maturity: z.number().int().positive('Maturity must be a positive integer'),
  timestamp: z.number().int().positive('Timestamp must be a positive integer'),
  borrowerIsTaker: z.boolean(),
  // makerTakerFeeAmount: z.string().regex(/^\d+$/, 'Fee amount must be a positive integer string'),
  // settlementFeeAmount: z.string().regex(/^\d+$/, 'Fee amount must be a positive integer string'),
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
  status: string;
  /** The order's remaining amount after the match */
  remainingAmount: string;
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

