/**
 * Redis Service
 *
 * Manages Redis connection and Stream operations for publishing settlement matches.
 * Uses ioredis for full Redis Streams support.
 */

import Redis, { type RedisOptions } from 'ioredis';
import {
  loadRedisConfig,
  REDIS_STREAMS,
  REDIS_CONSUMER_GROUPS,
  type RedisConfig,
} from '../config/redis-config';
import type { SettlementMatch, SettlementPublisher } from '../types/settlement';

/**
 * Redis Service class for managing connection and Stream operations
 *
 * Implements SettlementPublisher interface to publish settlement matches to Redis Streams.
 */
export class RedisService implements SettlementPublisher {
  private client: Redis | null = null;
  private config: RedisConfig;
  private isConnected = false;

  /**
   * Create a new Redis service instance
   *
   * @param config - Optional Redis configuration (loads from env if not provided)
   */
  constructor(config?: RedisConfig) {
    this.config = config || loadRedisConfig();
  }

  /**
   * Connect to Redis server
   *
   * @throws {Error} If connection fails
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      console.warn('Redis service is already connected');
      return;
    }

    try {
      console.log(`Connecting to Redis at ${this.config.url}...`);

      // Parse URL and build options
      const options: RedisOptions = {
        maxRetriesPerRequest: this.config.maxReconnectAttempts,
        retryStrategy: (times: number) => {
          if (times > this.config.maxReconnectAttempts) {
            console.error(
              `Redis: Max reconnect attempts (${this.config.maxReconnectAttempts}) exceeded`
            );
            return null; // Stop retrying
          }
          return this.config.reconnectTimeWait;
        },
        connectTimeout: this.config.timeout,
        db: this.config.db,
        lazyConnect: true,
      };

      // Add password if provided
      if (this.config.password) {
        options.password = this.config.password;
      }

      // Add TLS if enabled
      if (this.config.tls) {
        options.tls = {};
      }

      // Create client with URL and options
      this.client = new Redis(this.config.url, options);

      // Set up event handlers
      this.setupEventHandlers();

      // Connect
      await this.client.connect();
      this.isConnected = true;

      console.log('✓ Connected to Redis');

      // Ensure stream and consumer group exist
      await this.ensureStreamSetup();

      console.log('✓ Redis service initialized successfully');
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      throw new Error(
        `Redis connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Set up Redis event handlers
   */
  private setupEventHandlers(): void {
    if (!this.client) {
      return;
    }

    this.client.on('error', (err) => {
      console.error('Redis connection error:', err);
    });

    this.client.on('close', () => {
      this.isConnected = false;
      console.log('Redis connection closed');
    });

    this.client.on('reconnecting', () => {
      console.log('Redis reconnecting...');
    });

    this.client.on('ready', () => {
      this.isConnected = true;
      console.log('Redis connection ready');
    });
  }

  /**
   * Ensure the stream and consumer group are set up
   */
  private async ensureStreamSetup(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      // Try to create the consumer group (this also creates the stream if it doesn't exist)
      await this.client.xgroup(
        'CREATE',
        REDIS_STREAMS.SETTLEMENT_MATCHES,
        REDIS_CONSUMER_GROUPS.SETTLEMENT_ENGINE,
        '0',
        'MKSTREAM'
      );
      console.log(
        `✓ Created consumer group '${REDIS_CONSUMER_GROUPS.SETTLEMENT_ENGINE}' for stream '${REDIS_STREAMS.SETTLEMENT_MATCHES}'`
      );
    } catch (error) {
      // BUSYGROUP error means the group already exists, which is fine
      if (error instanceof Error && error.message.includes('BUSYGROUP')) {
        console.log(
          `✓ Consumer group '${REDIS_CONSUMER_GROUPS.SETTLEMENT_ENGINE}' already exists`
        );
      } else {
        console.warn('Warning: Could not create consumer group:', error);
      }
    }
  }

  /**
   * Publish a settlement match to Redis Stream
   *
   * Non-blocking: matching continues even if Redis publish fails.
   *
   * @param match - Settlement match to publish
   * @returns Message ID if successful, null otherwise
   */
  async publishSettlementMatch(match: SettlementMatch): Promise<string | null> {
    if (!this.client || !this.isConnected) {
      console.warn(
        'Redis not connected, skipping settlement match publish:',
        match.matchId
      );
      return null;
    }

    try {
      // Convert match object to flat key-value pairs for XADD
      const fields = this.matchToFields(match);

      // XADD to the stream with auto-generated ID (*)
      const messageId = await this.client.xadd(
        REDIS_STREAMS.SETTLEMENT_MATCHES,
        '*',
        ...fields
      );

      console.log(
        `Published settlement match ${match.matchId} to Redis Stream (ID: ${messageId})`
      );

      return messageId;
    } catch (error) {
      console.error('Failed to publish settlement match to Redis:', error);
      // Non-blocking: don't throw, just return null
      return null;
    }
  }

  /**
   * Convert a SettlementMatch object to flat field array for XADD
   *
   * @param match - Settlement match to convert
   * @returns Array of field-value pairs
   */
  private matchToFields(match: SettlementMatch): string[] {
    return [
      'matchId',
      match.matchId,
      'marketId',
      match.marketId,
      'lendOrderId',
      match.lendOrderId,
      'borrowOrderId',
      match.borrowOrderId,
      'lenderWallet',
      match.lenderWallet,
      'borrowerWallet',
      match.borrowerWallet,
      'matchedAmount',
      match.matchedAmount,
      'rate',
      match.rate.toString(),
      'loanToken',
      match.loanToken,
      'maturity',
      match.maturity.toString(),
      'timestamp',
      match.timestamp.toString(),
      'borrowerIsTaker',
      match.borrowerIsTaker.toString(),
      'makerFeeAmount',
      match.makerFeeAmount,
      'takerFeeAmount',
      match.takerFeeAmount,
      'lenderSettlementFeeAmount',
      match.lenderSettlementFeeAmount,
      'borrowerSettlementFeeAmount',
      match.borrowerSettlementFeeAmount,
    ];
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected || !this.client) {
      console.warn('Redis service is not connected');
      return;
    }

    console.log('Disconnecting from Redis...');

    try {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
      console.log('✓ Redis service disconnected');
    } catch (error) {
      console.error('Error during Redis disconnect:', error);
      throw error;
    }
  }

  /**
   * Check if the service is connected to Redis
   *
   * @returns True if connected, false otherwise
   */
  isServiceConnected(): boolean {
    return this.isConnected && this.client !== null;
  }

  /**
   * Get the Redis client instance
   *
   * @returns Redis client or null if not connected
   */
  getClient(): Redis | null {
    return this.client;
  }

  /**
   * Get stream information and statistics
   *
   * @returns Stream info or null if not connected
   */
  async getStreamInfo(): Promise<{
    length: number;
    groups: number;
  } | null> {
    if (!this.client || !this.isConnected) {
      return null;
    }

    try {
      const length = await this.client.xlen(REDIS_STREAMS.SETTLEMENT_MATCHES);

      // Get consumer groups info
      const groups = await this.client.xinfo(
        'GROUPS',
        REDIS_STREAMS.SETTLEMENT_MATCHES
      );

      return {
        length,
        groups: Array.isArray(groups) ? groups.length : 0,
      };
    } catch (error) {
      // Stream might not exist yet
      return { length: 0, groups: 0 };
    }
  }

  /**
   * Get service statistics
   *
   * @returns Object containing service statistics
   */
  getStats(): {
    connected: boolean;
    config: {
      url: string;
      db: number;
      hasAuth: boolean;
    };
  } {
    return {
      connected: this.isConnected,
      config: {
        url: this.config.url,
        db: this.config.db,
        hasAuth: Boolean(this.config.password),
      },
    };
  }

  /**
   * Health check for Redis connection
   *
   * @returns True if healthy, false otherwise
   */
  async healthCheck(): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}
