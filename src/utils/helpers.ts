import { v4 as uuidv4 } from 'uuid';
import type { Order, OrderSide } from '../types/orders';
import { loadFeeConfig } from '../config/fee-config';

/**
 * Generate a unique order ID
 *
 * @returns A UUID v4 string
 */
export function generateOrderId(): string {
  return uuidv4();
}

/**
 * Generate a unique match ID
 *
 * @returns A UUID v4 string
 */
export function generateMatchId(): string {
  return uuidv4();
}

/**
 * Generate a deterministic bytes32 hex marketId for tests / fallback use.
 *
 * MarketIds in production are derived from `keccak256(abi.encode(loanToken,
 * maturity))` truncated to 16 bytes and zero-padded (see backend's
 * `computeMarketId` + `uuidToBytes32`) — this helper produces a random
 * 32-byte hex string in the same shape (`0x` + 64 hex chars) for tests that
 * don't care about determinism. Use the production helper when you need
 * (loanToken, maturity) ↔ marketId equality.
 */
export function generateMarketId(): `0x${string}` {
  return `0x${uuidv4().replace(/-/g, '')}${'0'.repeat(32)}` as `0x${string}`;
}

/**
 * Validate Ethereum address format
 *
 * @param address - The address to validate
 * @returns True if valid, false otherwise
 */
export function validateTokenAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Calculate the execution rate for a match
 * For market orders, use the counterparty's limit rate
 * For limit orders, use the taker's rate
 *
 * @param lendRate - The lend order's rate (undefined for market orders)
 * @param borrowRate - The borrow order's rate (undefined for market orders)
 * @returns The execution rate in basis points
 */
export function calculateMatchRate(lendRate?: number, borrowRate?: number): number {
  // If both have rates, use the taker's rate (the one that came later)
  // In practice, this will be handled by the matching engine logic
  if (lendRate !== undefined && borrowRate !== undefined) {
    // Both are limit orders - use the better rate for matching
    // This shouldn't happen in practice as one must be taking the other
    return Math.min(lendRate, borrowRate);
  }

  // Market order matching with limit order - use limit order's rate
  if (lendRate !== undefined) {
    return lendRate;
  }

  if (borrowRate !== undefined) {
    return borrowRate;
  }

  // Both are market orders - this shouldn't happen but default to 0
  return 0;
}

/** Market orders get highest priority (lowest rate value) in lend book */
const MARKET_ORDER_LEND_RATE = Number.MAX_SAFE_INTEGER;
/** Market orders get highest priority (highest rate value) in borrow book */
const MARKET_ORDER_BORROW_RATE = Number.MIN_SAFE_INTEGER;

/**
 * Create a comparator function for Red-Black Tree ordering
 * Lend orders: sort by rate ascending (lowest first), then timestamp ascending
 * Borrow orders: sort by rate descending (highest first), then timestamp ascending
 *
 * @param side - The order side (Lend or Borrow)
 * @returns A comparator function for the Red-Black Tree
 */
export function createOrderComparator(side: OrderSide): (a: Order, b: Order) => number {
  if (side === 'LEND') {
    // Lend orders: lowest rate first (ascending)
    return (a: Order, b: Order): number => {
      // Handle market orders (no rate) - they should come last
      const aRate = 'rate' in a && a.rate !== undefined ? a.rate : MARKET_ORDER_LEND_RATE;
      const bRate = 'rate' in b && b.rate !== undefined ? b.rate : MARKET_ORDER_LEND_RATE;

      if (aRate !== bRate) {
        return aRate - bRate; // Ascending
      }
      // Price-time priority: earlier timestamp first
      return a.timestamp - b.timestamp;
    };
  } else {
    // Borrow orders: highest rate first (descending)
    return (a: Order, b: Order): number => {
      // Handle market orders (no rate) - they should come last
      const aRate = 'rate' in a && a.rate !== undefined ? a.rate : MARKET_ORDER_BORROW_RATE;
      const bRate = 'rate' in b && b.rate !== undefined ? b.rate : MARKET_ORDER_BORROW_RATE;

      if (aRate !== bRate) {
        return bRate - aRate; // Descending
      }
      // Price-time priority: earlier timestamp first
      return a.timestamp - b.timestamp;
    };
  }
}

/**
 * Compare two big number strings
 *
 * @param a - First number as string
 * @param b - Second number as string
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareBigNumbers(a: string, b: string): number {
  // Remove leading zeros
  const aClean = a.replace(/^0+/, '') || '0';
  const bClean = b.replace(/^0+/, '') || '0';

  // Compare by length first
  if (aClean.length !== bClean.length) {
    return aClean.length - bClean.length;
  }

  // Same length, compare lexicographically
  if (aClean < bClean) return -1;
  if (aClean > bClean) return 1;
  return 0;
}

/**
 * Add two big number strings
 *
 * @param a - First number as string
 * @param b - Second number as string
 * @returns Sum as string
 */
export function addBigNumbers(a: string, b: string): string {
  // Use BigInt for large number arithmetic
  return (BigInt(a) + BigInt(b)).toString();
}

/**
 * Subtract two big number strings (a - b)
 *
 * @param a - First number as string
 * @param b - Second number as string
 * @returns Difference as string
 * @throws Error if result would be negative
 */
export function subtractBigNumbers(a: string, b: string): string {
  const result = BigInt(a) - BigInt(b);
  if (result < 0n) {
    throw new Error('Result of subtraction cannot be negative');
  }
  return result.toString();
}

/**
 * Get minimum of two big number strings
 *
 * @param a - First number as string
 * @param b - Second number as string
 * @returns The smaller number as string
 */
export function minBigNumber(a: string, b: string): string {
  return compareBigNumbers(a, b) <= 0 ? a : b;
}

/**
 * Check if a big number string is zero
 *
 * @param a - Number as string
 * @returns True if zero
 */
export function isZero(a: string): boolean {
  return BigInt(a) === 0n;
}

/**
 * Calculate maker fee as a percentage of matched amount
 *
 * @param matchedAmount - The matched amount as a string
 * @param makerFeeBps - Optional maker fee in basis points (100 bps = 1%). Uses config when omitted.
 * @returns Maker fee amount as a string (floor division)
 */
export function calculateMakerFee(matchedAmount: string, makerFeeBps?: number): string {
  const bps =
    makerFeeBps !== undefined ? makerFeeBps : loadFeeConfig().makerFeeBps;
  return ((BigInt(matchedAmount) * BigInt(bps)) / 10000n).toString();
}

/**
 * Calculate taker fee as a percentage of matched amount
 *
 * @param matchedAmount - The matched amount as a string
 * @param takerFeeBps - Optional taker fee in basis points (100 bps = 1%). Uses config when omitted.
 * @returns Taker fee amount as a string (floor division)
 */
export function calculateTakerFee(matchedAmount: string, takerFeeBps?: number): string {
  const bps =
    takerFeeBps !== undefined ? takerFeeBps : loadFeeConfig().takerFeeBps;
  return ((BigInt(matchedAmount) * BigInt(bps)) / 10000n).toString();
}

/**
 * Calculate pro-rata settlement fee with rounding up
 *
 * Uses BigInt arithmetic to compute:
 *   ceil(totalFee * matchedAmount / originalAmount)
 *
 * @param totalFee - Total settlement fee for a fully filled order (as string)
 * @param matchedAmount - Matched amount for this fill (as string)
 * @param originalAmount - Original order amount (as string)
 * @returns Pro-rata settlement fee for this match (as string, rounded up)
 */
export function calculateProRataSettlementFee(
  totalFee: string,
  matchedAmount: string,
  originalAmount: string
): string {
  const totalFeeBigInt = BigInt(totalFee);
  const matchedAmountBigInt = BigInt(matchedAmount);
  const originalAmountBigInt = BigInt(originalAmount);

  if (originalAmountBigInt === 0n) {
    return '0';
  }

  const numerator = totalFeeBigInt * matchedAmountBigInt + (originalAmountBigInt - 1n);
  return (numerator / originalAmountBigInt).toString();
}
