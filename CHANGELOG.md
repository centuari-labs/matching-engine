# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-12-12

### Added

- Initial release of Centuari Matching Engine
- Support for market and limit orders (lend and borrow)
- Red-Black Tree based order book for O(log n) performance
- Price-time priority matching algorithm
- Partial fill support
- Multiple maturity date support per order
- Order cancellation
- Order book snapshots
- Match history tracking
- Trading statistics (volume, rates)
- Comprehensive test suite
- TypeScript with strict mode
- Zod schema validation for type safety
- Full JSDoc documentation

### Features

#### Order Types
- Lend Market Order
- Lend Limit Order
- Borrow Market Order
- Borrow Limit Order

#### Matching Logic
- Market orders match at best available rate
- Limit orders match when rate requirements are met
- Price priority: best rates matched first
- Time priority: within same price, FIFO matching
- Partial fills across multiple orders
- Multiple maturities per order

#### Performance
- O(log n) order insertion
- O(log n) order deletion
- O(1) best price retrieval
- Red-Black Tree data structure
- Efficient memory usage with BigInt support

#### API
- `submitOrder()`: Submit and match orders
- `cancelOrder()`: Cancel existing orders
- `getOrderStatus()`: Query order status
- `getOrderBook()`: View order book snapshot
- `getMatches()`: Get match history
- `getStatistics()`: Trading statistics

### Documentation

- Comprehensive README with examples
- API reference documentation
- Usage examples
- Architecture overview
- Performance benchmarks
- Contributing guidelines
- MIT License

## [Unreleased]

### Planned Features

- Order expiration/time-to-live
- Minimum/maximum order sizes
- Fee calculation integration
- WebSocket API for real-time updates
- Persistent storage integration
- Collateral ratio validation
- Risk management rules
- Additional matching strategies

