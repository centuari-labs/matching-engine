/**
 * NATS Service
 *
 * Manages NATS connection, subscriptions, and message routing for the
 * matching engine service.
 */

import {
  connect,
  type Msg,
  type NatsConnection,
  type ConnectionOptions,
  type Subscription,
} from 'nats';
import type { MatchingEngine } from '../core/matching-engine';
import { loadNatsConfig, NATS_TOPICS, type NatsConfig } from '../config/nats-config';
import {
  handleLendMarketOrder,
  handleLendLimitOrder,
  handleBorrowMarketOrder,
  handleBorrowLimitOrder,
  handleCancelOrderRequest,
  handleUpdateOrder,
  type HandlerContext,
} from './message-handlers';
import { createLogger } from '../utils/logger';
import { maskUrl } from '../utils/mask-url';

const log = createLogger('nats-service');

/**
 * Assert that NATS authentication is configured when running in production.
 *
 * The matching engine ingresses orders over NATS; an unauthenticated bus lets
 * any local peer inject/replay orders. In `NODE_ENV==='production'` we require
 * either user+password or a token and fail fast otherwise. Non-production
 * environments are unaffected so local dev keeps working without auth.
 *
 * @param config - Resolved NATS configuration
 * @throws {Error} If production and no credentials are present
 */
export function assertNatsAuthConfigured(config: NatsConfig): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const hasUserPass = Boolean(config.user && config.password);
  const hasToken = Boolean(config.token);

  if (!hasUserPass && !hasToken) {
    throw new Error(
      'NATS authentication is required in production: set NATS_USER + NATS_PASSWORD, ' +
        'or NATS_TOKEN. Refusing to connect to an unauthenticated message bus.'
    );
  }
}

/**
 * NATS Service class for managing connections and subscriptions
 */
export class NatsService {
  private nc: NatsConnection | null = null;
  private subscriptions: Subscription[] = [];
  private config: NatsConfig;
  private engine: MatchingEngine;
  private isConnected = false;

  /**
   * Create a new NATS service instance
   *
   * @param engine - Matching engine instance to use for order processing
   * @param config - Optional NATS configuration (loads from env if not provided)
   */
  constructor(engine: MatchingEngine, config?: NatsConfig) {
    this.engine = engine;
    this.config = config || loadNatsConfig();
  }

  /**
   * Connect to NATS server and set up subscriptions
   *
   * @throws {Error} If connection fails
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      log.warn('NATS service is already connected');
      return;
    }

    // In production the message bus must be authenticated at the app layer.
    // Fail fast on startup if neither user+password nor a token is configured,
    // rather than silently connecting to an open NATS server. Dev/test keep
    // the existing optional-auth behaviour.
    assertNatsAuthConfigured(this.config);

    try {
      log.info({ host: maskUrl(this.config.url) }, 'connecting to NATS');

      // Build connection options
      const options: ConnectionOptions = {
        servers: this.config.url.split(','),
        maxReconnectAttempts: this.config.maxReconnectAttempts,
        reconnectTimeWait: this.config.reconnectTimeWait,
        timeout: this.config.timeout,
      };

      // Add authentication if provided
      if (this.config.user && this.config.password) {
        options.user = this.config.user;
        options.pass = this.config.password;
      } else if (this.config.token) {
        options.token = this.config.token;
      }

      // Connect to NATS
      this.nc = await connect(options);
      this.isConnected = true;

      log.info('connected to NATS');

      // Set up connection event handlers
      this.setupConnectionHandlers();

      // Set up subscriptions
      await this.setupSubscriptions();

      log.info('NATS service initialized');
    } catch (error) {
      log.error({ err: error }, 'failed to connect to NATS');
      throw new Error(
        `NATS connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Set up connection event handlers
   */
  private setupConnectionHandlers(): void {
    if (!this.nc) {
      return;
    }

    // Handle connection closed
    this.nc.closed().then((err) => {
      this.isConnected = false;
      if (err) {
        log.error({ err }, 'NATS connection closed with error');
      } else {
        log.info('NATS connection closed');
      }
    });

    // Note: The 'nats' library handles reconnection automatically
    // based on the configuration options we provided
  }

  /**
   * Set up message subscriptions for all order topics
   */
  private async setupSubscriptions(): Promise<void> {
    if (!this.nc) {
      throw new Error('NATS connection not established');
    }

    const ctx: HandlerContext = {
      nc: this.nc,
      engine: this.engine,
    };

    // Subscribe to lend market orders
    const lendMarketSub = this.nc.subscribe(NATS_TOPICS.ORDERS_LEND_MARKET);
    this.subscriptions.push(lendMarketSub);
    this.processSubscription(lendMarketSub, (data) => handleLendMarketOrder(ctx, data));
    log.info({ topic: NATS_TOPICS.ORDERS_LEND_MARKET }, 'subscribed');

    // Subscribe to lend limit orders
    const lendLimitSub = this.nc.subscribe(NATS_TOPICS.ORDERS_LEND_LIMIT);
    this.subscriptions.push(lendLimitSub);
    this.processSubscription(lendLimitSub, (data) => handleLendLimitOrder(ctx, data));
    log.info({ topic: NATS_TOPICS.ORDERS_LEND_LIMIT }, 'subscribed');

    // Subscribe to borrow market orders
    const borrowMarketSub = this.nc.subscribe(NATS_TOPICS.ORDERS_BORROW_MARKET);
    this.subscriptions.push(borrowMarketSub);
    this.processSubscription(borrowMarketSub, (data) => handleBorrowMarketOrder(ctx, data));
    log.info({ topic: NATS_TOPICS.ORDERS_BORROW_MARKET }, 'subscribed');

    // Subscribe to borrow limit orders
    const borrowLimitSub = this.nc.subscribe(NATS_TOPICS.ORDERS_BORROW_LIMIT);
    this.subscriptions.push(borrowLimitSub);
    this.processSubscription(borrowLimitSub, (data) => handleBorrowLimitOrder(ctx, data));
    log.info({ topic: NATS_TOPICS.ORDERS_BORROW_LIMIT }, 'subscribed');

    // Subscribe to cancel requests (request/reply). The handler receives the
    // full message so it can reply the authoritative outcome to the requester.
    const cancelRequestSub = this.nc.subscribe(NATS_TOPICS.ORDERS_CANCEL_REQUEST);
    this.subscriptions.push(cancelRequestSub);
    this.processRequestSubscription(cancelRequestSub, (msg) => handleCancelOrderRequest(ctx, msg));
    log.info({ topic: NATS_TOPICS.ORDERS_CANCEL_REQUEST }, 'subscribed');

    // Subscribe to update orders
    const updateSub = this.nc.subscribe(NATS_TOPICS.ORDERS_UPDATE);
    this.subscriptions.push(updateSub);
    this.processSubscription(updateSub, (data) => handleUpdateOrder(ctx, data));
    log.info({ topic: NATS_TOPICS.ORDERS_UPDATE }, 'subscribed');
  }

  /**
   * Process messages from a subscription
   *
   * @param subscription - NATS subscription to process
   * @param handler - Handler function for processing messages
   */
  private async processSubscription(
    subscription: Subscription,
    handler: (data: Uint8Array) => void
  ): Promise<void> {
    // Process messages asynchronously
    (async () => {
      for await (const msg of subscription) {
        try {
          handler(msg.data);
        } catch (error) {
          log.error({ err: error }, 'error processing message');
        }
      }
    })().catch((error) => {
      log.error({ err: error }, 'subscription processing error');
    });
  }

  /**
   * Process messages from a request/reply subscription.
   *
   * Identical to {@link processSubscription} except the handler receives the
   * full `Msg` (not just `msg.data`) so it can call `msg.respond(...)`.
   *
   * @param subscription - NATS subscription to process
   * @param handler - Handler function that receives the full message
   */
  private async processRequestSubscription(
    subscription: Subscription,
    handler: (msg: Msg) => void
  ): Promise<void> {
    (async () => {
      for await (const msg of subscription) {
        try {
          handler(msg);
        } catch (error) {
          log.error({ err: error }, 'error processing request message');
        }
      }
    })().catch((error) => {
      log.error({ err: error }, 'request subscription processing error');
    });
  }

  /**
   * Disconnect from NATS and clean up subscriptions
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      log.warn('NATS service is not connected');
      return;
    }

    log.info('disconnecting from NATS');

    try {
      // Unsubscribe from all topics
      for (const sub of this.subscriptions) {
        await sub.drain();
      }
      this.subscriptions = [];

      // Close NATS connection
      if (this.nc) {
        await this.nc.drain();
        this.nc = null;
      }

      this.isConnected = false;
      log.info('NATS service disconnected');
    } catch (error) {
      log.error({ err: error }, 'error during NATS disconnect');
      throw error;
    }
  }

  /**
   * Check if the service is connected to NATS
   *
   * @returns True if connected, false otherwise
   */
  isServiceConnected(): boolean {
    return this.isConnected && this.nc !== null;
  }

  /**
   * Get the NATS connection instance
   *
   * @returns NATS connection or null if not connected
   */
  getConnection(): NatsConnection | null {
    return this.nc;
  }

  /**
   * Get service statistics
   *
   * @returns Object containing service statistics
   */
  getStats(): {
    connected: boolean;
    subscriptions: number;
    config: {
      url: string;
      hasAuth: boolean;
    };
  } {
    return {
      connected: this.isConnected,
      subscriptions: this.subscriptions.length,
      config: {
        url: this.config.url,
        hasAuth: Boolean(this.config.user || this.config.token),
      },
    };
  }
}
