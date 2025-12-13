# Centuari Matching Engine

A high-performance matching engine for Web3 lending and borrowing built with TypeScript and Red-Black Trees.

## Overview

This matching engine efficiently matches lend and borrow orders for decentralized lending protocols. It supports:

- **Market and Limit Orders**: Both lend and borrow sides
- **Multiple Maturities**: Orders can specify multiple maturity dates
- **Partial Fills**: Orders can be partially filled across multiple matches
- **Price-Time Priority**: Best prices matched first, then earliest orders
- **High Performance**: O(log n) order operations using Red-Black Trees

## Features

### Order Types

1. **Lend Market Order**: Lend at the best available rate
2. **Lend Limit Order**: Lend at a specified minimum rate
3. **Borrow Market Order**: Borrow at the best available rate
4. **Borrow Limit Order**: Borrow at a specified maximum rate

### Matching Logic

- **Market Orders**: Execute immediately at the best available counterparty rate
- **Limit Orders**: Execute only when rate requirements are met
- **Price Priority**: Best rates matched first (lowest for lend, highest for borrow)
- **Time Priority**: Within same price, earlier orders matched first (FIFO)

## Installation

```bash
npm install @centuari/matching-engine
```

## Quick Start

```typescript
import { MatchingEngine, OrderSide, OrderType, OrderStatus } from '@centuari/matching-engine';

// Initialize the matching engine
const engine = new MatchingEngine();

// Create a lend limit order
const lendOrder = {
  orderId: '550e8400-e29b-41d4-a716-446655440000',
  loanToken: '0x1234567890123456789012345678901234567890',
  maturities: [1704067200], // Unix timestamp for maturity date
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '1000000', // Amount in token's smallest unit
  remainingAmount: '1000000',
  rate: 500, // Interest rate in basis points (500 = 5%)
};

// Submit the order
const result = engine.submitOrder(lendOrder);

console.log('Matches:', result.matches);
console.log('Remaining Order:', result.remainingOrder);
```

## Usage Examples

### Example 1: Simple Limit Order Matching

```typescript
import { MatchingEngine, generateOrderId } from '@centuari/matching-engine';
import { OrderSide, OrderType, OrderStatus } from '@centuari/matching-engine';

const engine = new MatchingEngine();

// Lender offers to lend at 5% (500 basis points)
const lendOrder = {
  orderId: generateOrderId(),
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  maturities: [1704067200],
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '1000000000', // 1000 USDC (6 decimals)
  remainingAmount: '1000000000',
  rate: 500,
};

// Borrower willing to pay 6% (600 basis points)
const borrowOrder = {
  orderId: generateOrderId(),
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  maturities: [1704067200],
  timestamp: Date.now(),
  side: OrderSide.Borrow,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '500000000', // 500 USDC
  remainingAmount: '500000000',
  rate: 600,
  collateralTokens: ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'], // WETH
};

// Submit orders
engine.submitOrder(lendOrder);
const result = engine.submitOrder(borrowOrder);

// Result:
// - Match created for 500 USDC at 5% (lender's rate - they were first)
// - Lend order partially filled: 500 USDC remaining
// - Borrow order fully filled
console.log(result.matches[0]);
// {
//   matchId: "...",
//   lendOrderId: "...",
//   borrowOrderId: "...",
//   matchedAmount: "500000000",
//   rate: 500,
//   loanToken: "0xA0b...",
//   collateralTokens: ["0xC02..."],
//   maturity: 1704067200,
//   timestamp: 1234567890
// }
```

### Example 2: Market Order Execution

```typescript
import { MatchingEngine, generateOrderId } from '@centuari/matching-engine';
import { OrderSide, OrderType, OrderStatus } from '@centuari/matching-engine';

const engine = new MatchingEngine();

// Add two lend limit orders at different rates
const lendOrder1 = {
  orderId: generateOrderId(),
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  maturities: [1704067200],
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '500000000',
  remainingAmount: '500000000',
  rate: 400, // 4%
};

const lendOrder2 = {
  orderId: generateOrderId(),
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  maturities: [1704067200],
  timestamp: Date.now() + 1,
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '700000000',
  remainingAmount: '700000000',
  rate: 600, // 6%
};

engine.submitOrder(lendOrder1);
engine.submitOrder(lendOrder2);

// Submit borrow market order - will match at best rates
const borrowMarketOrder = {
  orderId: generateOrderId(),
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  maturities: [1704067200],
  timestamp: Date.now() + 2,
  side: OrderSide.Borrow,
  type: OrderType.Market,
  status: OrderStatus.Open,
  originalAmount: '1000000000', // 1000 USDC
  remainingAmount: '1000000000',
  collateralTokens: ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
};

const result = engine.submitOrder(borrowMarketOrder);

// Matches at best rates first:
// - 500 USDC at 4%
// - 500 USDC at 6%
console.log(result.matches.length); // 2
console.log(result.matches[0].rate); // 400 (best rate first)
console.log(result.matches[1].rate); // 600
```

### Example 3: Multiple Maturities

```typescript
import { MatchingEngine, generateOrderId } from '@centuari/matching-engine';
import { OrderSide, OrderType, OrderStatus } from '@centuari/matching-engine';

const engine = new MatchingEngine();

// Add lend orders at different maturities
const lendOrder1 = {
  orderId: generateOrderId(),
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  maturities: [1704067200], // Jan 2024
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '500000000',
  remainingAmount: '500000000',
  rate: 500,
};

const lendOrder2 = {
  orderId: generateOrderId(),
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  maturities: [1735689600], // Jan 2025
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '600000000',
  remainingAmount: '600000000',
  rate: 500,
};

engine.submitOrder(lendOrder1);
engine.submitOrder(lendOrder2);

// Borrow order with multiple maturities
const borrowOrder = {
  orderId: generateOrderId(),
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  maturities: [1704067200, 1735689600], // Both maturities
  timestamp: Date.now(),
  side: OrderSide.Borrow,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '1000000000',
  remainingAmount: '1000000000',
  rate: 600,
  collateralTokens: ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
};

const result = engine.submitOrder(borrowOrder);

// Matches across both maturities
console.log(result.matches.length); // 2
console.log(result.matches[0].maturity); // 1704067200
console.log(result.matches[1].maturity); // 1735689600
```

### Example 4: Order Cancellation

```typescript
const engine = new MatchingEngine();

const order = {
  orderId: generateOrderId(),
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  maturities: [1704067200],
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '1000000000',
  remainingAmount: '1000000000',
  rate: 500,
};

const result = engine.submitOrder(order);

// Cancel the order
const cancelled = engine.cancelOrder(order.orderId);
console.log(cancelled); // true

// Check order status
const status = engine.getOrderStatus(order.orderId);
console.log(status); // null (order removed)
```

### Example 5: View Order Book

```typescript
const engine = new MatchingEngine();

// Add some orders...
// (submit orders as shown in previous examples)

// View order book for specific token and maturity
const snapshot = engine.getOrderBook(
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  1704067200, // Maturity
  10 // Depth (top 10 orders per side)
);

console.log('Lend Orders:', snapshot.lendOrders);
// [
//   { orderId: "...", rate: 400, amount: "500000000", timestamp: ... },
//   { orderId: "...", rate: 500, amount: "1000000000", timestamp: ... },
//   ...
// ]

console.log('Borrow Orders:', snapshot.borrowOrders);
// [
//   { orderId: "...", rate: 800, amount: "300000000", timestamp: ..., collateralTokens: [...] },
//   { orderId: "...", rate: 700, amount: "500000000", timestamp: ..., collateralTokens: [...] },
//   ...
// ]
```

### Example 6: Get Match History

```typescript
const engine = new MatchingEngine();

// Submit orders and create matches...
const result = engine.submitOrder(borrowOrder);

// Get all matches for an order
const matches = engine.getMatches(borrowOrder.orderId);
console.log('Total matches:', matches.length);

// Get statistics
const stats = engine.getStatistics(
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  1704067200
);

console.log(stats);
// {
//   totalMatches: 15,
//   totalVolume: 10000000000n,
//   averageRate: 525,
//   minRate: 400,
//   maxRate: 700
// }
```

## API Reference

### MatchingEngine

#### `submitOrder(order: Order): MatchResult`

Submit an order to the matching engine. The order will be matched against existing orders and added to the order book if not fully filled.

**Parameters:**
- `order`: Order object (LendMarketOrder | LendLimitOrder | BorrowMarketOrder | BorrowLimitOrder)

**Returns:**
- `MatchResult`: Object containing matches array and remaining order info

#### `cancelOrder(orderId: string): boolean`

Cancel an existing order.

**Parameters:**
- `orderId`: UUID of the order to cancel

**Returns:**
- `boolean`: True if order was cancelled, false if not found

#### `getOrderStatus(orderId: string): OrderStatus | null`

Get the current status of an order.

**Parameters:**
- `orderId`: UUID of the order

**Returns:**
- `OrderStatus`: Order status enum value or null if not found

#### `getOrderBook(loanToken: string, maturity: number, depth?: number): OrderBookSnapshot`

Get a snapshot of the order book for a specific token and maturity.

**Parameters:**
- `loanToken`: Ethereum address of the loan token
- `maturity`: Unix timestamp of the maturity date
- `depth`: Maximum number of orders to return per side (default: 10)

**Returns:**
- `OrderBookSnapshot`: Object containing lend and borrow orders

#### `getMatches(orderId: string): Match[]`

Get all matches for a specific order.

**Parameters:**
- `orderId`: UUID of the order

**Returns:**
- `Match[]`: Array of match objects

#### `getStatistics(loanToken: string, maturity: number): Statistics | null`

Get trading statistics for a specific token and maturity.

**Parameters:**
- `loanToken`: Ethereum address of the loan token
- `maturity`: Unix timestamp of the maturity date

**Returns:**
- `Statistics`: Object containing volume and rate statistics

### Types

#### Order Types

```typescript
interface LendMarketOrder {
  orderId: string; // UUID
  loanToken: string; // Ethereum address
  maturities: number[]; // Unix timestamps
  timestamp: number;
  side: OrderSide.Lend;
  type: OrderType.Market;
  status: OrderStatus;
  originalAmount: string; // BigInt as string
  remainingAmount: string;
}

interface LendLimitOrder extends LendMarketOrder {
  type: OrderType.Limit;
  rate: number; // Basis points
}

interface BorrowMarketOrder {
  orderId: string;
  loanToken: string;
  maturities: number[];
  timestamp: number;
  side: OrderSide.Borrow;
  type: OrderType.Market;
  status: OrderStatus;
  originalAmount: string;
  remainingAmount: string;
  collateralTokens: string[]; // Ethereum addresses
}

interface BorrowLimitOrder extends BorrowMarketOrder {
  type: OrderType.Limit;
  rate: number; // Basis points
}
```

#### Enums

```typescript
enum OrderSide {
  Lend = 'LEND',
  Borrow = 'BORROW',
}

enum OrderType {
  Market = 'MARKET',
  Limit = 'LIMIT',
}

enum OrderStatus {
  Open = 'OPEN',
  PartiallyFilled = 'PARTIALLY_FILLED',
  Filled = 'FILLED',
  Cancelled = 'CANCELLED',
}
```

## Architecture

### Components

1. **MatchingEngine**: Main entry point and orchestrator
2. **OrderBook**: Manages orders using Red-Black Trees for efficient matching
3. **ExecutionEngine**: Records and manages match results
4. **Types & Schemas**: Zod validation schemas for type safety

### Data Structures

The matching engine uses Red-Black Trees for O(log n) performance:

- **Insertion**: O(log n)
- **Deletion**: O(log n)
- **Get Best Price**: O(1)
- **Iteration**: O(k) where k is the number of orders

### Matching Algorithm

1. **Order Submission**: Validate and check for immediate matches
2. **Price Discovery**: Find best available counterparty orders
3. **Execution**: Create matches and update order states
4. **Record Keeping**: Store match results for history
5. **Order Book Update**: Add remaining orders to the book

## Performance

The matching engine is designed for high performance:

- **Red-Black Trees**: Guaranteed O(log n) operations
- **Indexed Lookups**: O(1) order retrieval by ID
- **Efficient Matching**: Orders sorted by price-time priority
- **Large Numbers**: BigInt support for arbitrary precision

### Benchmarks

Typical performance on modern hardware:

- Order submission: < 1ms
- Matching with 1000 orders: < 10ms
- Order book snapshot: < 1ms

## Testing

Run the test suite:

```bash
npm test
```

Test coverage includes:

- Order validation
- Matching logic for all order types
- Partial fills
- Multiple maturities
- Price-time priority
- Edge cases and error handling

## Integration with Backend

The matching engine is designed to integrate with a backend service via NATS:

```typescript
// Backend pseudocode
nats.subscribe('orders.submit', async (msg) => {
  const order = validateOrder(msg.data);
  const result = matchingEngine.submitOrder(order);
  
  // Process settlements based on matches
  for (const match of result.matches) {
    await processSettlement(match);
  }
  
  msg.respond(result);
});
```

## License

MIT

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting pull requests.

## Support

For issues, questions, or feature requests, please open an issue on GitHub.

