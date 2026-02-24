# Centuari Matching Engine

A high-performance matching engine for Web3 lending and borrowing built with TypeScript and Red-Black Trees.

## Overview

This matching engine efficiently matches lend and borrow orders for decentralized lending protocols. It supports:

- **Market and Limit Orders**: Both lend and borrow sides
- **Multiple Markets**: Orders specify one or more markets via a `markets` array (each entry has a `marketId` UUID and `maturity` timestamp)
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

// Create a lend limit order (markets: array of { marketId, maturity } per market)
const lendOrder = {
  orderId: '550e8400-e29b-41d4-a716-446655440000',
  loanToken: '0x1234567890123456789012345678901234567890',
  walletAddress: '0x1111111111111111111111111111111111111111',
  markets: [{ marketId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', maturity: 1704067200 }],
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '1000000',
  remainingAmount: '1000000',
  settlementFeeAmount: '10000',
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
  walletAddress: '0x1111111111111111111111111111111111111111',
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  markets: [{ marketId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', maturity: 1704067200 }],
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '1000000000',
  remainingAmount: '1000000000',
  settlementFeeAmount: '10000',
  rate: 500,
};

// Borrower willing to pay 6% (600 basis points)
const borrowOrder = {
  orderId: generateOrderId(),
  walletAddress: '0x2222222222222222222222222222222222222222',
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  markets: [{ marketId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', maturity: 1704067200 }],
  timestamp: Date.now(),
  side: OrderSide.Borrow,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '500000000',
  remainingAmount: '500000000',
  settlementFeeAmount: '10000',
  rate: 600,
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
const marketSlot = { marketId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', maturity: 1704067200 };
const lendOrder1 = {
  orderId: generateOrderId(),
  walletAddress: '0x1111111111111111111111111111111111111111',
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  markets: [marketSlot],
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '500000000',
  remainingAmount: '500000000',
  settlementFeeAmount: '10000',
  rate: 400,
};

const lendOrder2 = {
  orderId: generateOrderId(),
  walletAddress: '0x1111111111111111111111111111111111111111',
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  markets: [marketSlot],
  timestamp: Date.now() + 1,
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '700000000',
  remainingAmount: '700000000',
  settlementFeeAmount: '10000',
  rate: 600,
};

engine.submitOrder(lendOrder1);
engine.submitOrder(lendOrder2);

// Submit borrow market order - will match at best rates
const borrowMarketOrder = {
  orderId: generateOrderId(),
  walletAddress: '0x2222222222222222222222222222222222222222',
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  markets: [marketSlot],
  timestamp: Date.now() + 2,
  side: OrderSide.Borrow,
  type: OrderType.Market,
  status: OrderStatus.Open,
  originalAmount: '1000000000',
  remainingAmount: '1000000000',
  settlementFeeAmount: '10000',
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

// Add lend orders at different maturities (each market: { marketId, maturity })
const lendOrder1 = {
  orderId: generateOrderId(),
  walletAddress: '0x1111111111111111111111111111111111111111',
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  markets: [{ marketId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', maturity: 1704067200 }], // Jan 2024
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '500000000',
  remainingAmount: '500000000',
  settlementFeeAmount: '10000',
  rate: 500,
};

const lendOrder2 = {
  orderId: generateOrderId(),
  walletAddress: '0x1111111111111111111111111111111111111111',
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  markets: [{ marketId: '7ca7b810-9dad-11d1-80b4-00c04fd430c9', maturity: 1735689600 }], // Jan 2025
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '600000000',
  remainingAmount: '600000000',
  settlementFeeAmount: '10000',
  rate: 500,
};

engine.submitOrder(lendOrder1);
engine.submitOrder(lendOrder2);

// Borrow order with multiple maturities
const borrowOrder = {
  orderId: generateOrderId(),
  walletAddress: '0x2222222222222222222222222222222222222222',
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  markets: [
    { marketId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', maturity: 1704067200 },
    { marketId: '7ca7b810-9dad-11d1-80b4-00c04fd430c9', maturity: 1735689600 },
  ],
  timestamp: Date.now(),
  side: OrderSide.Borrow,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '1000000000',
  remainingAmount: '1000000000',
  settlementFeeAmount: '10000',
  rate: 600,
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
  walletAddress: '0x1111111111111111111111111111111111111111',
  loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  markets: [{ marketId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', maturity: 1704067200 }],
  timestamp: Date.now(),
  side: OrderSide.Lend,
  type: OrderType.Limit,
  status: OrderStatus.Open,
  originalAmount: '1000000000',
  remainingAmount: '1000000000',
  settlementFeeAmount: '10000',
  rate: 500,
};

const result = engine.submitOrder(order);

// Cancel the order (wallet address must match the order owner)
const cancelled = engine.cancelOrder(order.orderId, order.walletAddress);
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

#### `cancelOrder(orderId: string, walletAddress: string): boolean`

Cancel an existing order. The wallet address must match the order owner.

**Parameters:**
- `orderId`: UUID of the order to cancel
- `walletAddress`: Ethereum address of the order owner (must match the order's wallet address)

**Returns:**
- `boolean`: True if order was cancelled, false if not found or wallet address doesn't match

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

Orders use a unified `markets` array instead of separate maturity lists. Each entry is a **market slot** with both a market UUID and maturity timestamp.

```typescript
interface MarketSlot {
  marketId: string; // UUID
  maturity: number; // Unix timestamp
}

interface LendMarketOrder {
  orderId: string;
  walletAddress: string;
  loanToken: string;
  markets: MarketSlot[]; // At least one; each has marketId + maturity
  timestamp: number;
  side: OrderSide.Lend;
  type: OrderType.Market;
  status: OrderStatus;
  originalAmount: string;
  remainingAmount: string;
  settlementFeeAmount: string;
}

interface LendLimitOrder extends LendMarketOrder {
  type: OrderType.Limit;
  rate: number; // Basis points
}

interface BorrowMarketOrder {
  orderId: string;
  walletAddress: string;
  loanToken: string;
  markets: MarketSlot[];
  timestamp: number;
  side: OrderSide.Borrow;
  type: OrderType.Market;
  status: OrderStatus;
  originalAmount: string;
  remainingAmount: string;
  settlementFeeAmount: string;
}

interface BorrowLimitOrder extends BorrowMarketOrder {
  type: OrderType.Limit;
  rate: number;
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

### Test data factories

To keep tests resilient to schema changes, orders and matches should be created
using the shared factory helpers:

- `src/__tests__/factories/order-factory.ts` – helpers for creating all order
  types (`createLendLimitOrder`, `createBorrowLimitOrder`, etc.) with sensible
  defaults for amounts, fee fields, and `markets`. Use `marketsFromMaturities([...])`
  in overrides when you only need to set maturities (deterministic marketIds are derived).
- `src/__tests__/factories/match-factory.ts` – helper for creating `Match`
  instances with default fee fields derived from the matched amount.

New tests that need orders or matches should prefer these factories plus
per-test overrides instead of constructing objects inline.

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

## Running with Docker

The project provides a single Dockerfile that builds one image. You can run either the matching engine or the DB writer from that image.

**Build the image:**

```bash
docker build -t matching-engine .
```

**Run the matching engine (default):**

```bash
docker run --env-file .env matching-engine
```

**Run the DB writer (override command):**

```bash
docker run --env-file .env matching-engine node dist/services/db-writer-main.js
```

Both services require the same environment variables: `NATS_URL`, `REDIS_URL`, `DB_URL`, and related options. See `env.example` for the full list. Do not bake secrets into the image; pass them at runtime via `--env-file` or `-e`.

**Connect to existing NATS / Redis / Postgres containers**

If NATS, Redis, and Postgres are already running in Docker (with ports published to the host), the matching-engine container cannot use `localhost`—inside the container that points to the container itself. Use `host.docker.internal` (Docker Desktop on Mac or Windows) so the app reaches the host, where your other containers’ ports are published:

```bash
docker run --env-file .env \
  -e NATS_URL=nats://host.docker.internal:4222 \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e DB_URL=postgres://USER:PASSWORD@host.docker.internal:5432/DATABASE \
  matching-engine
```

Replace `USER`, `PASSWORD`, and `DATABASE` with your Postgres credentials (e.g. the same as used by `centuari-postgres`). The `-e` flags override any `NATS_URL`/`REDIS_URL`/`DB_URL` in `.env`, so you can keep `localhost` in `.env` for local (non-Docker) runs.

For running both services as separate containers (e.g. in Dokploy or Docker Compose), use the same image twice: one deployment with the default command (matching engine), the other with command `node dist/services/db-writer-main.js`.

## License

MIT

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting pull requests.

## Support

For issues, questions, or feature requests, please open an issue on GitHub.

