import type { NatsConnection, Subscription } from 'nats';
import Redis from 'ioredis';
import { NATS_TOPICS } from '../config/nats-config';
import {
  REDIS_CONSUMER_GROUPS,
  REDIS_STREAMS,
} from '../config/redis-config';
import {
  orderStatusMessageSchema,
  cancelledRemainderMessageSchema,
  type OrderStatusMessage,
  type CancelledRemainderMessage,
} from '../types/messages';
import { matchSchema, type Match } from '../types/matches';
import type { DbClient } from '../types/db';
import { createLogger } from '../utils/logger';

const log = createLogger('db-writer-service');

const DB_WRITER_DEFAULTS = {
  MAX_CONCURRENCY: 10,
  REDIS_BLOCK_TIMEOUT_MS: 5000,
  REDIS_BATCH_SIZE: 50,
  MAX_INSERT_RETRIES: 3,
  PENDING_RECOVERY_INTERVAL_MS: 30000,
  PENDING_MIN_IDLE_MS: 30000,
} as const;

export interface DbWriterOptions {
  /**
   * Maximum number of concurrent DB operations.
   * Applied separately per source (NATS and Redis).
   */
  maxConcurrency?: number;

  /**
   * Redis consumer group name. Defaults to REDIS_CONSUMER_GROUPS.DB_WRITER.
   */
  redisConsumerGroup?: string;

  /**
   * Redis consumer name inside the consumer group.
   */
  redisConsumerName?: string;

  /**
   * Block timeout for XREADGROUP in milliseconds.
   */
  redisBlockTimeoutMs?: number;

  /**
   * Maximum number of stream entries to read per XREADGROUP call.
   */
  redisBatchSize?: number;

  /**
   * Maximum number of retries for transient DB insert failures.
   */
  maxInsertRetries?: number;

  /**
   * How often (ms) the PEL recovery loop runs to reclaim stale entries.
   */
  pendingRecoveryIntervalMs?: number;

  /**
   * Minimum idle time (ms) before a pending entry is reclaimed.
   */
  pendingMinIdleMs?: number;
}

/**
 * DbWriterService
 *
 * Listens to:
 *  - NATS `orders.status` for order updates
 *  - Redis Stream `settlement:matches` (own consumer group) for match inserts
 *
 * And translates those events into idempotent DB writes using the provided
 * DbClient implementation.
 */
export class DbWriterService {
  private readonly nc: NatsConnection;
  private readonly redis: Redis;
  private readonly dbClient: DbClient;
  private readonly options: Required<DbWriterOptions>;

  private natsSubscription: Subscription | null = null;
  private natsCancelledRemainderSub: Subscription | null = null;
  private redisRunning = false;
  private redisWorkerPromise: Promise<void> | null = null;
  private pendingRecoveryPromise: Promise<void> | null = null;
  private pendingRecoveryWakeup: (() => void) | null = null;

  constructor(
    nc: NatsConnection,
    redis: Redis,
    dbClient: DbClient,
    options?: DbWriterOptions
  ) {
    this.nc = nc;
    this.redis = redis;
    this.dbClient = dbClient;

    this.options = {
      maxConcurrency: options?.maxConcurrency ?? DB_WRITER_DEFAULTS.MAX_CONCURRENCY,
      redisConsumerGroup:
        options?.redisConsumerGroup ?? REDIS_CONSUMER_GROUPS.DB_WRITER,
      redisConsumerName:
        options?.redisConsumerName ?? `db-writer-${process.pid}`,
      redisBlockTimeoutMs: options?.redisBlockTimeoutMs ?? DB_WRITER_DEFAULTS.REDIS_BLOCK_TIMEOUT_MS,
      redisBatchSize: options?.redisBatchSize ?? DB_WRITER_DEFAULTS.REDIS_BATCH_SIZE,
      maxInsertRetries: options?.maxInsertRetries ?? DB_WRITER_DEFAULTS.MAX_INSERT_RETRIES,
      pendingRecoveryIntervalMs:
        options?.pendingRecoveryIntervalMs ?? DB_WRITER_DEFAULTS.PENDING_RECOVERY_INTERVAL_MS,
      pendingMinIdleMs: options?.pendingMinIdleMs ?? DB_WRITER_DEFAULTS.PENDING_MIN_IDLE_MS,
    };
  }

  /**
   * Start NATS subscription and Redis Stream consumption.
   */
  async start(): Promise<void> {
    this.startNatsSubscription();
    this.startCancelledRemainderSubscription();
    await this.ensureRedisGroup();
    this.startRedisWorker();
    this.startPendingRecovery();
  }

  /**
   * Stop all background workers and release resources.
   */
  async stop(): Promise<void> {
    if (this.natsSubscription) {
      await this.natsSubscription.drain();
      this.natsSubscription = null;
    }

    if (this.natsCancelledRemainderSub) {
      await this.natsCancelledRemainderSub.drain();
      this.natsCancelledRemainderSub = null;
    }

    this.redisRunning = false;
    // Wake the PEL recovery loop so it exits immediately instead of
    // blocking on its interval sleep.
    if (this.pendingRecoveryWakeup) {
      this.pendingRecoveryWakeup();
      this.pendingRecoveryWakeup = null;
    }
    if (this.redisWorkerPromise) {
      await this.redisWorkerPromise;
      this.redisWorkerPromise = null;
    }
    if (this.pendingRecoveryPromise) {
      await this.pendingRecoveryPromise;
      this.pendingRecoveryPromise = null;
    }

    await this.dbClient.close();
  }

  /**
   * Subscribe to the ORDERS_STATUS topic and apply updates to the DB.
   */
  private startNatsSubscription(): void {
    const sub = this.nc.subscribe(NATS_TOPICS.ORDERS_STATUS);
    this.natsSubscription = sub;

    const maxConcurrency = this.options.maxConcurrency;
    let inFlight = 0;

    (async () => {
      for await (const msg of sub) {
        // Simple bounded concurrency: if too many messages are in flight,
        // wait until some of them complete.
        // This keeps DB load under control.
        while (inFlight >= maxConcurrency) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        inFlight += 1;

        void this.handleOrderStatusMessage(msg.data)
          .catch((error) => {
            log.error({ err: error }, 'failed to handle order status message');
          })
          .finally(() => {
            inFlight -= 1;
          });
      }
    })().catch((error) => {
      log.error({ err: error }, 'NATS subscription loop failed');
    });

    log.info({ topic: NATS_TOPICS.ORDERS_STATUS }, 'subscribed to NATS topic');
  }

  private async handleOrderStatusMessage(data: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(data);
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      log.error({ err: error, rawMessage: text }, 'failed to parse order status JSON');
      return;
    }

    let message: OrderStatusMessage;
    try {
      message = orderStatusMessageSchema.parse(parsed);
    } catch (error) {
      log.error({ err: error }, 'invalid order status message');
      return;
    }

    await this.dbClient.updateOrderStatus(message);
  }

  /**
   * Subscribe to the ORDERS_CANCELLED_REMAINDER topic and insert cancelled
   * remainder order rows into the DB.
   */
  private startCancelledRemainderSubscription(): void {
    const sub = this.nc.subscribe(NATS_TOPICS.ORDERS_CANCELLED_REMAINDER);
    this.natsCancelledRemainderSub = sub;

    const maxConcurrency = this.options.maxConcurrency;
    let inFlight = 0;

    (async () => {
      for await (const msg of sub) {
        while (inFlight >= maxConcurrency) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        inFlight += 1;

        void this.handleCancelledRemainderMessage(msg.data)
          .catch((error) => {
            log.error({ err: error }, 'failed to handle cancelled remainder message');
          })
          .finally(() => {
            inFlight -= 1;
          });
      }
    })().catch((error) => {
      log.error({ err: error }, 'cancelled remainder subscription loop failed');
    });

    log.info({ topic: NATS_TOPICS.ORDERS_CANCELLED_REMAINDER }, 'subscribed to NATS topic');
  }

  private async handleCancelledRemainderMessage(data: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(data);
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      log.error({ err: error, rawMessage: text }, 'failed to parse cancelled remainder JSON');
      return;
    }

    let message: CancelledRemainderMessage;
    try {
      message = cancelledRemainderMessageSchema.parse(parsed);
    } catch (error) {
      log.error({ err: error }, 'invalid cancelled remainder message');
      return;
    }

    await this.dbClient.insertCancelledOrder(message);
  }

  /**
   * Ensure the Redis consumer group for DB Writer exists.
   *
   * Uses a separate consumer group from the Settlement Engine so that
   * acknowledgements here do not impact other consumers of the same
   * stream.
   */
  private async ensureRedisGroup(): Promise<void> {
    try {
      await this.redis.xgroup(
        'CREATE',
        REDIS_STREAMS.SETTLEMENT_MATCHES,
        this.options.redisConsumerGroup,
        '0',
        'MKSTREAM'
      );
      log.info({ group: this.options.redisConsumerGroup, stream: REDIS_STREAMS.SETTLEMENT_MATCHES }, 'created consumer group');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('BUSYGROUP')) {
        log.info({ group: this.options.redisConsumerGroup }, 'consumer group already exists');
      } else {
        log.warn({ err: error }, 'failed to create Redis consumer group');
      }
    }
  }

  /**
   * Start the Redis Stream consumer loop.
   */
  private startRedisWorker(): void {
    if (this.redisRunning) {
      return;
    }

    this.redisRunning = true;
    this.redisWorkerPromise = this.redisWorkerLoop();
  }

  private async redisWorkerLoop(): Promise<void> {
    const group = this.options.redisConsumerGroup;
    const consumer = this.options.redisConsumerName;
    const blockMs = this.options.redisBlockTimeoutMs;
    const batchSize = this.options.redisBatchSize;
    const maxConcurrency = this.options.maxConcurrency;

    let inFlight = 0;

    while (this.redisRunning) {
      try {
        // Respect bounded concurrency: if DB is saturated, pause reads.
        if (inFlight >= maxConcurrency) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }

        const streams = (await this.redis.xreadgroup(
          'GROUP',
          group,
          consumer,
          'COUNT',
          batchSize,
          'BLOCK',
          blockMs,
          'STREAMS',
          REDIS_STREAMS.SETTLEMENT_MATCHES,
          '>'
        )) as [string, [string, string[]][]][] | null;

        if (!streams || streams.length === 0) {
          continue;
        }

        for (const [, entries] of streams) {
          for (const [id, fields] of entries) {
            // Each entry is processed with bounded concurrency.
            inFlight += 1;

            void this.handleRedisEntry(id, fields)
              .catch((error) => {
                log.error({ err: error }, 'failed to handle Redis match entry');
              })
              .finally(() => {
                inFlight -= 1;
              });
          }
        }
      } catch (error) {
        log.error({ err: error }, 'Redis worker error, retrying');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleRedisEntry(
    id: string,
    fields: string[]
  ): Promise<void> {
    const match = this.fieldsToMatch(fields);

    // Validate against core schema
    let validated: Match;
    try {
      validated = matchSchema.parse(match);
    } catch (error) {
      log.error({ err: error }, 'invalid match entry from Redis');
      // Acknowledge the bad entry so it does not block the consumer group.
      await this.redis.xack(
        REDIS_STREAMS.SETTLEMENT_MATCHES,
        this.options.redisConsumerGroup,
        id
      );
      return;
    }

    // Retry with exponential backoff for transient DB failures.
    // On exhaustion the error propagates so the entry stays un-ACKd
    // in the PEL and will be reclaimed by pendingRecoveryLoop.
    const maxRetries = this.options.maxInsertRetries;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.dbClient.insertMatch(validated);
        break; // Success — proceed to ACK
      } catch (error) {
        if (attempt === maxRetries) {
          log.error({ matchId: validated.matchId, attempts: maxRetries, err: error }, 'match insert failed after all attempts, leaving un-ACKd for PEL recovery');
          throw error; // Propagate — do NOT ACK
        }
        const backoffMs = 100 * Math.pow(2, attempt - 1);
        log.warn({ matchId: validated.matchId, attempt, maxRetries, backoffMs, err: error }, 'match insert failed, retrying');
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    // Acknowledge within the DB_WRITER consumer group only. Other
    // consumer groups (e.g. Settlement Engine) still see the message
    // independently.
    await this.redis.xack(
      REDIS_STREAMS.SETTLEMENT_MATCHES,
      this.options.redisConsumerGroup,
      id
    );
  }

  /**
   * Start the PEL (Pending Entries List) recovery loop.
   */
  private startPendingRecovery(): void {
    this.pendingRecoveryPromise = this.pendingRecoveryLoop();
  }

  /**
   * Periodically reclaim entries that were delivered but never ACK'd
   * (e.g. because all retry attempts failed or the process crashed).
   * Uses XAUTOCLAIM to claim entries idle longer than pendingMinIdleMs.
   */
  private async pendingRecoveryLoop(): Promise<void> {
    const group = this.options.redisConsumerGroup;
    const consumer = this.options.redisConsumerName;
    const minIdleMs = this.options.pendingMinIdleMs;
    const intervalMs = this.options.pendingRecoveryIntervalMs;

    while (this.redisRunning) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        this.pendingRecoveryWakeup = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (!this.redisRunning) break;

      try {
        const result = await this.redis.xautoclaim(
          REDIS_STREAMS.SETTLEMENT_MATCHES,
          group,
          consumer,
          minIdleMs,
          '0-0',
          'COUNT',
          this.options.redisBatchSize
        );

        // result: [nextStartId, [[id, fields], ...], deletedIds]
        const entries = result[1] as [string, string[]][];
        if (!entries || entries.length === 0) continue;

        log.info({ count: entries.length }, 'reclaiming pending entries from PEL');

        for (const [id, fields] of entries) {
          try {
            await this.handleRedisEntry(id, fields);
          } catch (error) {
            log.error({ entryId: id, err: error }, 'PEL recovery failed for entry');
            // Entry remains in PEL — will be retried on next cycle
          }
        }
      } catch (error) {
        log.error({ err: error }, 'PEL recovery loop error');
      }
    }
  }

  /**
   * Convert flat Redis field array into a Match-like object.
   */
  private fieldsToMatch(fields: string[]): Partial<Match> {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      obj[key] = value;
    }

    return {
      matchId: obj.matchId,
      marketId: obj.marketId,
      lendOrderId: obj.lendOrderId,
      borrowOrderId: obj.borrowOrderId,
      lenderWallet: obj.lenderWallet,
      borrowerWallet: obj.borrowerWallet,
      matchedAmount: obj.matchedAmount,
      rate: obj.rate ? Number(obj.rate) : 0,
      loanToken: obj.loanToken,
      maturity: obj.maturity ? Number(obj.maturity) : 0,
      timestamp: obj.timestamp ? Number(obj.timestamp) : 0,
      borrowerIsTaker: obj.borrowerIsTaker === 'true',
      makerFeeAmount: obj.makerFeeAmount ?? '0',
      takerFeeAmount: obj.takerFeeAmount ?? '0',
      lenderSettlementFeeAmount: obj.lenderSettlementFeeAmount ?? '0',
      borrowerSettlementFeeAmount: obj.borrowerSettlementFeeAmount ?? '0',
    };
  }
}

