import { z } from 'zod';
import { ethereumAddressSchema } from './orders';

/**
 * Match schema representing a successful match between lend and borrow orders
 */
export const matchSchema = z.object({
  matchId: z.string().uuid('Match ID must be a valid UUID'),
  lendOrderId: z.string().uuid('Lend order ID must be a valid UUID'),
  borrowOrderId: z.string().uuid('Borrow order ID must be a valid UUID'),
  matchedAmount: z.string().regex(/^\d+$/, 'Matched amount must be a positive integer string'),
  rate: z
    .number()
    .int('Rate must be an integer')
    .min(0, 'Rate must be non-negative')
    .max(100000, 'Rate must not exceed 100000 basis points (1000%)'),
  loanToken: ethereumAddressSchema,
  collateralTokens: z.array(ethereumAddressSchema),
  maturity: z.number().int().positive('Maturity must be a positive integer'),
  timestamp: z.number().int().positive('Timestamp must be a positive integer'),
});

/**
 * TypeScript type inferred from match schema
 */
export type Match = z.infer<typeof matchSchema>;

/**
 * Match result returned after order submission
 */
export interface MatchResult {
  matches: Match[];
  remainingOrder: {
    orderId: string;
    remainingAmount: string;
    status: string;
  } | null;
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
    collateralTokens: string[];
  }>;
}

