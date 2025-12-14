# NATS Integration Guide

This document explains how to use the NATS integration layer for the Matching Engine.

## Overview

The NATS service provides a message broker integration that allows external backend services to interact with the matching engine through publish-subscribe messaging patterns.

## Architecture

```
Backend Service (Another Repo)
        ↓
    NATS Broker
        ↓
  NATS Service (this repo)
        ↓
  Matching Engine
        ↓
    NATS Broker
        ↓
Backend Service (Another Repo)
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

This will install:
- `nats` - NATS client library
- `dotenv` - Environment variable management
- `ts-node` - TypeScript execution (dev)

### 2. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your NATS configuration:

```env
NATS_URL=nats://localhost:4222
NATS_USER=your-username
NATS_PASSWORD=your-password
```

### 3. Start NATS Server (Local Development)

Using Docker:

```bash
docker run -p 4222:4222 nats
```

Or install NATS server: https://docs.nats.io/running-a-nats-service/introduction/installation

### 4. Start the Matching Engine Service

Development mode:

```bash
npm start
```

Production mode:

```bash
npm run build
npm run start:prod
```

## NATS Topics

### Input Topics (Service Subscribes)

The service listens to these topics for incoming orders:

- `orders.lend.market` - Lend market orders
- `orders.lend.limit` - Lend limit orders
- `orders.borrow.market` - Borrow market orders
- `orders.borrow.limit` - Borrow limit orders
- `orders.cancel` - Order cancellation requests

### Output Topics (Service Publishes)

The service publishes results to these topics:

- `matches.created` - Match results after order processing
- `orders.status` - Order status updates
- `orderbook.snapshot` - Order book snapshot responses
- `errors` - Error notifications

## Message Formats

### Publishing an Order

**Lend Limit Order:**

```typescript
await nats.publish('orders.lend.limit', JSON.stringify({
  orderId: '123e4567-e89b-12d3-a456-426614174000',
  loanToken: '0x1234567890123456789012345678901234567890',
  maturities: [1704067200000],
  timestamp: Date.now(),
  side: 'LEND',
  type: 'LIMIT',
  originalAmount: '1000000',
  remainingAmount: '1000000',
  status: 'OPEN',
  rate: 500
}));
```

**Borrow Market Order:**

```typescript
await nats.publish('orders.borrow.market', JSON.stringify({
  orderId: '123e4567-e89b-12d3-a456-426614174000',
  loanToken: '0x1234567890123456789012345678901234567890',
  maturities: [1704067200000],
  collateralTokens: ['0x...', '0x...'],
  timestamp: Date.now(),
  side: 'BORROW',
  type: 'MARKET',
  originalAmount: '500000',
  remainingAmount: '500000',
  status: 'OPEN'
}));
```

### Subscribing to Match Results

```typescript
const sub = nats.subscribe('matches.created');

for await (const msg of sub) {
  const result = JSON.parse(msg.data.toString());
  
  console.log('Order ID:', result.orderId);
  console.log('Matches:', result.matches);
  console.log('Remaining Order:', result.remainingOrder);
}
```

### Cancelling an Order

```typescript
await nats.publish('orders.cancel', JSON.stringify({
  orderId: '123e4567-e89b-12d3-a456-426614174000',
  timestamp: Date.now()
}));
```

## Error Handling

Errors are published to the `errors` topic:

```typescript
const errorSub = nats.subscribe('errors');

for await (const msg of errorSub) {
  const error = JSON.parse(msg.data.toString());
  
  console.error('Error Code:', error.code);
  console.error('Message:', error.message);
  console.error('Order ID:', error.orderId);
  console.error('Details:', error.details);
}
```

### Error Codes

- `VALIDATION_ERROR` - Invalid order data
- `INVALID_ORDER` - Order doesn't meet business rules
- `ORDER_NOT_FOUND` - Order ID not found for cancellation
- `RATE_MISMATCH` - Rate doesn't match available liquidity
- `INSUFFICIENT_LIQUIDITY` - No matching orders available
- `INTERNAL_ERROR` - Internal service error
- `NATS_CONNECTION_ERROR` - NATS connection issue
- `MESSAGE_PARSE_ERROR` - Failed to parse message

## Programmatic Usage

You can also use the NATS service programmatically:

```typescript
import { MatchingEngine, NatsService } from '@centuari/matching-engine';

async function startService() {
  // Create matching engine
  const engine = new MatchingEngine();
  
  // Create NATS service
  const natsService = new NatsService(engine, {
    url: 'nats://localhost:4222',
    maxReconnectAttempts: 10,
    reconnectTimeWait: 2000,
    timeout: 10000
  });
  
  // Connect to NATS
  await natsService.connect();
  
  console.log('Service started!');
  
  // Check status
  const stats = natsService.getStats();
  console.log('Connected:', stats.connected);
  console.log('Subscriptions:', stats.subscriptions);
  
  // Handle shutdown
  process.on('SIGINT', async () => {
    await natsService.disconnect();
    process.exit(0);
  });
}

startService();
```

## Testing

Run the test suite:

```bash
npm test
```

Run NATS integration tests (requires running NATS server):

```bash
npm test -- nats-service.test.ts
```

## Configuration Options

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NATS_URL` | NATS server URL(s), comma-separated for clustering | `nats://localhost:4222` |
| `NATS_USER` | Optional username for authentication | - |
| `NATS_PASSWORD` | Optional password for authentication | - |
| `NATS_TOKEN` | Optional token for authentication | - |
| `NATS_MAX_RECONNECT_ATTEMPTS` | Maximum reconnection attempts | `10` |
| `NATS_RECONNECT_TIME_WAIT` | Wait time between reconnects (ms) | `2000` |
| `NATS_TIMEOUT` | Connection timeout (ms) | `10000` |
| `NODE_ENV` | Node environment | `development` |

### Clustering

For high availability, connect to multiple NATS servers:

```env
NATS_URL=nats://server1:4222,nats://server2:4222,nats://server3:4222
```

## Monitoring

The service logs key events:

- Connection status
- Order processing
- Match creation
- Errors

Example log output:

```
=================================
Matching Engine Service Starting
=================================

Configuration:
  NATS URL: nats://localhost:4222
  Node Environment: development

Initializing matching engine...
✓ Matching engine initialized

Initializing NATS service...
Connecting to NATS at nats://localhost:4222...
✓ Connected to NATS
✓ Subscribed to orders.lend.market
✓ Subscribed to orders.lend.limit
✓ Subscribed to orders.borrow.market
✓ Subscribed to orders.borrow.limit
✓ Subscribed to orders.cancel
✓ NATS service initialized successfully

Service Status:
  Connected: true
  Active Subscriptions: 6
  NATS Server: nats://localhost:4222
  Authentication: Disabled

=================================
Service is ready to process orders
Press Ctrl+C to stop
=================================
```

## Future Enhancements

The modular architecture makes it easy to add:

- **WebSocket Service**: Real-time order updates for web clients
- **HTTP API Service**: REST API for direct order submission
- **Metrics**: Prometheus metrics endpoint
- **Health Checks**: Kubernetes-ready health endpoints
- **Rate Limiting**: Per-user rate limits
- **Message Persistence**: Durable subscriptions for guaranteed delivery

## Troubleshooting

### Connection Refused

**Problem**: `Error: connect ECONNREFUSED 127.0.0.1:4222`

**Solution**: Ensure NATS server is running:
```bash
docker run -p 4222:4222 nats
```

### Authentication Failed

**Problem**: `Error: Authorization Violation`

**Solution**: Check `NATS_USER` and `NATS_PASSWORD` in `.env`

### Message Not Processing

**Problem**: Orders published but no matches returned

**Solution**: 
1. Check topic names match exactly
2. Verify message format matches schemas
3. Check service logs for errors
4. Ensure order meets matching criteria

## Support

For issues or questions:
- Check the main [README.md](./README.md)
- Review test files in `src/__tests__/`
- Examine message handlers in `src/services/message-handlers.ts`

