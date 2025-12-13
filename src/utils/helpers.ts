import { v4 as uuidv4 } from 'uuid';
import type { Order, OrderSide } from '../types/orders';

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
      const aRate = 'rate' in a && a.rate !== undefined ? a.rate : Number.MAX_SAFE_INTEGER;
      const bRate = 'rate' in b && b.rate !== undefined ? b.rate : Number.MAX_SAFE_INTEGER;

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
      const aRate = 'rate' in a && a.rate !== undefined ? a.rate : Number.MIN_SAFE_INTEGER;
      const bRate = 'rate' in b && b.rate !== undefined ? b.rate : Number.MIN_SAFE_INTEGER;

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

