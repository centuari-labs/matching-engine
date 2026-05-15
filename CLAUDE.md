# CLAUDE.md — Matching Engine

## Stack

Node.js · TypeScript (strict) · functional-red-black-tree · NATS 2 · ioredis (Streams) · PostgreSQL (raw pg) · Zod · Jest 29 · ESLint + Prettier · pnpm (scripts use npm)

## Commands

```bash
npm run dev                        # tsc --watch
npm run start:matching-engine      # ts-node src/services/main.ts
npm run start:db-writer            # ts-node src/services/db-writer-main.ts
npm run start                      # runs both engine + db-writer
npm run test                       # jest --silent
npm run test:verbose               # jest --verbose
npm run lint                       # eslint src --ext .ts
npm run format                     # prettier --write "src/**/*.ts"
```

## Architecture

```
src/
├── core/
│   ├── matching-engine.ts     # Main orchestrator — receives orders, triggers matching
│   ├── order-book.ts          # Red-black tree order management (lend + borrow sides)
│   └── execution-engine.ts    # Records matches, publishes to Redis, tracks unpublished
├── services/
│   ├── main.ts                # Engine entry point
│   ├── db-writer-main.ts      # DB writer entry point (separate process)
│   ├── db-writer-service.ts   # Consumes NATS + Redis Stream, persists to PostgreSQL
│   ├── message-handlers.ts    # NATS message parsing and routing
│   ├── nats-service.ts        # NATS connection and subscription management
│   ├── redis-service.ts       # Redis Stream publisher (settlement:matches)
│   ├── snapshot-service.ts    # Filesystem + Redis snapshot persistence
│   └── db/
│       └── postgres-db-client.ts  # Raw pg client for DB writer
├── config/                    # Zod-validated config loaders (nats, redis, db, fee)
├── types/                     # Zod schemas + TypeScript types (orders, matches, messages, settlement, snapshot)
├── utils/
│   └── helpers.ts             # Big number math, fee calculations, comparators
├── __tests__/
│   ├── factories/             # Test data factories (order-factory, match-factory)
│   └── *.test.ts              # Feature-based test files
└── index.ts                   # Public exports
```

### Two Processes, One Codebase

1. **Matching Engine** (`main.ts`) — hot path. Maintains in-memory order books, matches orders, publishes to Redis Streams. No database writes.
2. **DB Writer** (`db-writer-main.ts`) — cold path. Subscribes to NATS `orders.status` + Redis Stream `settlement:matches`. Persists state to PostgreSQL. Keeps DB I/O off the matching hot path.

### Order Book Structure

```
OrderBook
├── lendTrees: Map<loanToken, Map<maturity, RedBlackTree>>   # price ascending, time ascending
├── borrowTrees: Map<loanToken, Map<maturity, RedBlackTree>> # price descending, time ascending
└── orderIndex: Map<orderId, OrderMetadata>                  # O(1) lookup by ID
```

### Match Flow

```
NATS message → Zod parse → Validate → Match against order book → Record in ExecutionEngine
→ Publish to Redis Stream (fire-and-forget) → On success: remove from memory (Redis is source of truth)
                                             → On failure: keep in memory as buffer
```

## Order Lock Lifecycle

### DB-writer locks at match time, settlement-engine releases at settlement

On every match the DB-writer increments `portfolio.locked_amount` for both lender and borrower in [postgres-db-client.ts:216-254](src/services/db/postgres-db-client.ts) inside the same transaction that INSERTs the `matches` row. The lock is released by settlement-engine's `writebackSettledMatches` once the on-chain settlement lands — see [settlement-engine/src/settlement/database/lock-release.ts](../settlement-engine/src/settlement/database/lock-release.ts).

Decomposition the engine-side increment uses (mirrored exactly by the release):

- **lender:** `matchedAmount + lenderSettlementFeeAmount + lenderTradeFee`
- **borrower:** `borrowerSettlementFeeAmount + borrowerTradeFee`
- **trade-fee split:** `borrowerTradeFee = takerFeeAmount` if `borrowerIsTaker`, else `makerFeeAmount`. Lender pays the opposite.

The `UPDATE` order is sorted by `account_id` ascending to avoid deadlocks with concurrent transactions touching the same rows. Settlement-engine mirrors this ordering.

Backend reads `portfolio.locked_amount` for its available-balance formula but never writes it — see [../backend-v2/CLAUDE.md](../backend-v2/CLAUDE.md) "Order Lock Lifecycle" section for the read-side semantics.

### Known cancel race window (unfixed in Phase 1)

For the cancel-during-match race window (a cancel arriving between engine-publishes-match and db-writer-flushes-`status=FILLED` is silently overwritten because [`updateOrderStatus` at postgres-db-client.ts:53-72](src/services/db/postgres-db-client.ts) has no `WHERE status = ?` guard) and the planned engine-coordinated-cancel fix, see [../smart-contract-revamp/docs/hub-only-launch-plan.md](../smart-contract-revamp/docs/hub-only-launch-plan.md) Track C (deep reference in [archive/order-lock-lifecycle-followups.md](../smart-contract-revamp/docs/archive/order-lock-lifecycle-followups.md)).

## Code Standards

### Naming

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `order-book.ts`, `db-writer-main.ts` |
| Classes | PascalCase | `MatchingEngine`, `OrderBook`, `NatsService` |
| Functions | camelCase | `matchLendLimitOrder`, `getBestOrders`, `publishSettlementMatch` |
| Factories | `create` prefix | `createLendLimitOrder`, `createBorrowMarketOrder` |
| Predicates | `is` prefix | `isLendOrder`, `isMarketOrder`, `isZero` |
| Constants | SCREAMING_SNAKE_CASE | `DEFAULT_LOAN_TOKEN`, `NATS_TOPICS`, `ERROR_CODES` |
| Config objects | SCREAMING_SNAKE_CASE | `NATS_TOPICS`, `REDIS_STREAMS`, `REDIS_CONSUMER_GROUPS` |
| Enums | PascalCase members | `OrderSide.Lend`, `OrderStatus.Open` |
| Types/Interfaces | PascalCase | `Order`, `Match`, `MatchResult`, `AffectedOrder` |

### Clean Code Rules

1. **Core is pure logic** — `core/` has zero I/O dependencies. `MatchingEngine`, `OrderBook`, and `ExecutionEngine` accept injected interfaces (`SettlementPublisher`, `SnapshotService`) — never import NATS/Redis/pg directly.
2. **Zod for all external boundaries** — every NATS message, Redis entry, config value, and snapshot is validated with Zod schemas. Parse once at the boundary, use typed data internally.
3. **Amounts as strings** — all token amounts are digit-only strings (no decimals, no signs). Use `helpers.ts` for big number arithmetic. Never use `Number` or `parseFloat` for financial math.
4. **No side effects in core** — matching functions return `MatchResult` objects. The caller decides what to publish/persist.
5. **Interface-driven services** — define interfaces (`SettlementPublisher`, `DbClient`) for external dependencies. Implement concretely in `services/`. Test with mocks.
6. **Config validation on startup** — all config loaded via Zod `.safeParse()` with aggregated error reporting. Fail fast on invalid config.
7. **Self-matching prevention** — the matching engine never matches orders from the same wallet.
8. **IOC for market orders** — market orders are Immediate-or-Cancel. Unmatched remainder is cancelled, not placed in the book.
9. **Atomic snapshots** — write to `.tmp` file, then rename. Never leave partial snapshots on disk.
10. **Concurrency control in DB Writer** — limit concurrent DB operations via `maxConcurrency`. Don't overwhelm the database.
11. **No `as any` casts** — Use proper type wrappers (e.g., `OrderWithSettlementTracking`) for runtime-added fields. If a field doesn't exist on the type, extend the type — never cast to `any`.
12. **Single handler pattern** — NATS message handlers that differ only by schema/label must use a single generic handler function. No copy-paste of handler logic per order type.
13. **Structured logging** — Use the logger interface (`src/utils/logger.ts`), not raw `console.log/warn/error`. Log with structured fields: `{ service, orderId?, matchId?, ... }`.
14. **Memory buffer eviction** — Any in-memory buffer (matches, orders, caches) must have a max-age eviction policy and a max-size cap. Document the eviction strategy in comments.
15. **No `z.any()` in Zod schemas** — All schema fields must be properly typed. Use schema references (`matchSchema`, `orderSchema`) instead of `z.any()`. If complex types cause circular imports, restructure the type hierarchy.
16. **Named constants** — No magic numbers in business logic. Extract sentinel values, timeouts, batch sizes, and thresholds into named constants.

### Testing Rules

- 80% coverage threshold on branches, functions, lines, and statements
- Use factories (`order-factory.ts`, `match-factory.ts`) for test data — never inline object literals
- One test file per feature: `price-time-priority.test.ts`, `partial-fills.test.ts`, `maker-taker-fee.test.ts`
- Integration tests suffixed with `.integration.test.ts`
- Mock NATS/Redis in unit tests — test core logic in isolation
- Core data structures (`OrderBook`, `ExecutionEngine`) must have dedicated unit test files — not only indirect coverage through integration tests

### Error Handling

- Standardized `ErrorMessage` format: `{ code, message, orderId?, details?, timestamp }`
- Error codes defined in `types/messages.ts`: `VALIDATION_ERROR`, `INVALID_ORDER`, `ORDER_NOT_FOUND`, etc.
- Publish errors to NATS `errors` topic for observability
- Snapshot save failures are non-blocking (logged, not thrown)
- Match publish failures keep the match in memory as a buffer

### Formatting

Prettier: 2-space indent, single quotes, 100-char print width, trailing commas (ES5). ESLint with `@typescript-eslint`. Run `npm run lint` before committing.
