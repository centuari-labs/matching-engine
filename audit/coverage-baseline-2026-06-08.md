# matching-engine — Test Coverage Baseline

- **Date:** 2026-06-08
- **Scope:** external-audit prep (hub-only launch), Phase 2.3
- **Command:** `TZ=UTC npm run test -- --coverage` (Jest 29 + ts-jest)
- **Infra:** PostgreSQL/Redis/NATS up via root `docker-compose` (integration
  tests in `db-writer.integration.test.ts` require a live DB — `.env` pointed at
  the running `centuari` Postgres for this run).

## Test result

```
Test Suites: 41 passed, 41 total
Tests:       551 passed, 4 skipped, 555 total
```

`TZ=UTC npm run test` (no `--coverage`) is **green** — all 551 tests pass. The
`--coverage` invocation exits non-zero **only** because the configured 80%
threshold is not met (see below); no test fails.

## Coverage vs threshold

Configured threshold (`jest.config.js`): **80%** on branches, functions, lines,
statements (global).

| Metric | Actual | Threshold | Met? |
|---|---|---|---|
| Statements | **69.88%** (1246/1783) | 80% | ❌ |
| Branches | **67.71%** (409/604) | 80% | ❌ |
| Functions | **65.83%** (210/319) | 80% | ❌ |
| Lines | **70.42%** (1212/1721) | 80% | ❌ |

> The 80% gate is currently **aspirational, not enforced in a way that blocks the
> green `npm run test` run** — the threshold check fires only under `--coverage`.
> Core matching logic is well covered; the shortfall is concentrated in process
> entry points and I/O-side service code (see below).

## Where the gap is (lowest-covered units)

| File | % Lines | Note |
|---|---|---|
| `services/main.ts` | 0% | engine process entry point — not unit-tested |
| `services/db-writer-main.ts` | 0% | DB-writer process entry point — not unit-tested |
| `utils/logger.ts` | 0% | logger is mocked in `setup.ts`; never exercised |
| `types/settlement.ts` | 0% | schema module, lightly imported |
| `services/snapshot-service.ts` | ~63% | error/branch paths uncovered |
| `services/db/postgres-db-client.ts` | ~64% | SQL paths 346–519 uncovered |

By contrast, `src/core` (the matching hot path) sits at **~93%** statements
(`order-book.ts` 100%, `execution-engine.ts` ~98%, `matching-engine.ts` ~84%).

## Disposition

- **Baseline recorded; not remediated in this pass.** Phase 2.3 is a baseline
  capture, not a coverage push. Raising global coverage to the 80% gate is
  tracked as separate follow-up test work (entry-point smoke tests + DB-client
  SQL-path tests + snapshot error-path tests would close most of the gap).
- Auditors should note core matching/order-book logic is the well-covered
  surface; the gap is in process bootstrap and I/O glue, not in match correctness.
