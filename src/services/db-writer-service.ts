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
import { truncatePayload } from '../utils/log-sanitize';

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
      maxConcurrency: options?.maxConcurrency ?? 10,
      redisConsumerGroup:
        options?.redisConsumerGroup ?? REDIS_CONSUMER_GROUPS.DB_WRITER,
      redisConsumerName:
        options?.redisConsumerName ?? `db-writer-${process.pid}`,
      redisBlockTimeoutMs: options?.redisBlockTimeoutMs ?? 5000,
      redisBatchSize: options?.redisBatchSize ?? 50,
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
    if (this.redisWorkerPromise) {
      await this.redisWorkerPromise;
      this.redisWorkerPromise = null;
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
            console.error('DB Writer: failed to handle order status message', error);
          })
          .finally(() => {
            inFlight -= 1;
          });
      }
    })().catch((error) => {
      console.error('DB Writer: NATS subscription loop failed', error);
    });

    console.log(`DbWriterService subscribed to ${NATS_TOPICS.ORDERS_STATUS}`);
  }

  private async handleOrderStatusMessage(data: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(data);
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.error(
        'DB Writer: failed to parse order status JSON',
        error instanceof Error ? error.message : String(error),
        truncatePayload(text)
      );
      return;
    }

    let message: OrderStatusMessage;
    try {
      message = orderStatusMessageSchema.parse(parsed);
    } catch (error) {
      console.error(
        'DB Writer: invalid order status message',
        error instanceof Error ? error.message : String(error),
        truncatePayload(parsed)
      );
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
            console.error('DB Writer: failed to handle cancelled remainder message', error);
          })
          .finally(() => {
            inFlight -= 1;
          });
      }
    })().catch((error) => {
      console.error('DB Writer: cancelled remainder subscription loop failed', error);
    });

    console.log(`DbWriterService subscribed to ${NATS_TOPICS.ORDERS_CANCELLED_REMAINDER}`);
  }

  private async handleCancelledRemainderMessage(data: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(data);
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.error(
        'DB Writer: failed to parse cancelled remainder JSON',
        error instanceof Error ? error.message : String(error),
        truncatePayload(text)
      );
      return;
    }

    let message: CancelledRemainderMessage;
    try {
      message = cancelledRemainderMessageSchema.parse(parsed);
    } catch (error) {
      console.error(
        'DB Writer: invalid cancelled remainder message',
        error instanceof Error ? error.message : String(error),
        truncatePayload(parsed)
      );
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
      console.log(
        `DbWriterService created consumer group '${this.options.redisConsumerGroup}' for stream '${REDIS_STREAMS.SETTLEMENT_MATCHES}'`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('BUSYGROUP')) {
        console.log(
          `DbWriterService consumer group '${this.options.redisConsumerGroup}' already exists`
        );
      } else {
        console.warn(
          'DbWriterService: failed to create Redis consumer group',
          error
        );
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
                console.error('DB Writer: failed to handle Redis match entry', error);
              })
              .finally(() => {
                inFlight -= 1;
              });
          }
        }
      } catch (error) {
        console.error('DB Writer: Redis worker error, retrying...', error);
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
      console.error(
        'DB Writer: invalid match entry from Redis',
        error instanceof Error ? error.message : String(error),
        truncatePayload(match)
      );
      // Acknowledge the bad entry so it does not block the consumer group.
      await this.redis.xack(
        REDIS_STREAMS.SETTLEMENT_MATCHES,
        this.options.redisConsumerGroup,
        id
      );
      return;
    }

    await this.dbClient.insertMatch(validated);

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

