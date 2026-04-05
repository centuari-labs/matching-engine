/**
 * Retry Service
 *
 * Implements BufferEventHandler to manage retry scheduling for failed
 * match publishes. Uses exponential backoff and delegates disk persistence.
 * All timer and async logic lives here, keeping the core pure.
 */

import type { Match } from '../types/matches';
import type { BufferEventHandler } from '../types/buffer';
import type { BufferConfig } from '../config/buffer-config';
import type { ExecutionEngine } from '../core/execution-engine';
import type { DiskPersistenceService } from './disk-persistence-service';

export class RetryService implements BufferEventHandler {
  private executionEngine: ExecutionEngine | null = null;
  private readonly diskService: DiskPersistenceService;
  private readonly config: BufferConfig;

  /** Per-match retry timers */
  private retryTimers: Map<string, NodeJS.Timeout> = new Map();

  /** Per-match retry attempt counts (for backoff calculation) */
  private retryAttempts: Map<string, number> = new Map();

  /** Tracks matchIds with an in-flight publish to prevent overlapping retries */
  private inFlight: Set<string> = new Set();

  constructor(diskService: DiskPersistenceService, config: BufferConfig) {
    this.diskService = diskService;
    this.config = config;
  }

  /**
   * Set the execution engine reference (two-phase init)
   *
   * Must be called after the MatchingEngine is constructed.
   */
  setExecutionEngine(engine: ExecutionEngine): void {
    this.executionEngine = engine;
  }

  /**
   * Called when a match fails to publish to Redis
   *
   * Schedules a retry with exponential backoff if not already retrying.
   */
  onPublishFailed(match: Match): void {
    const matchId = match.matchId;

    // Don't schedule if already has a pending timer or in-flight publish
    if (this.retryTimers.has(matchId) || this.inFlight.has(matchId)) {
      return;
    }

    // Track retry attempts
    const attempt = this.retryAttempts.get(matchId) ?? 0;
    this.retryAttempts.set(matchId, attempt + 1);

    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.config.retryInitialDelayMs * Math.pow(this.config.retryBackoffMultiplier, attempt),
      this.config.retryMaxDelayMs
    );

    // Mark as retrying in the execution engine
    this.executionEngine?.markRetrying(matchId);

    // Schedule retry
    const timer = setTimeout(() => {
      this.retryTimers.delete(matchId);

      if (!this.executionEngine) return;

      // Guard against overlapping retries
      this.inFlight.add(matchId);
      this.executionEngine.retryPublish(matchId);
      this.inFlight.delete(matchId);
    }, delay);

    this.retryTimers.set(matchId, timer);
  }

  /**
   * Called when a match is successfully published
   *
   * Clears retry state for this match.
   */
  onPublishSucceeded(matchId: string): void {
    // Clear timer if pending
    const timer = this.retryTimers.get(matchId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(matchId);
    }

    // Clean up tracking
    this.retryAttempts.delete(matchId);
    this.inFlight.delete(matchId);
    this.executionEngine?.unmarkRetrying(matchId);
  }

  /**
   * Called when buffer size crosses a warning threshold
   */
  onThresholdBreached(currentSize: number, threshold: number): void {
    console.warn(
      `[RetryService] Buffer threshold breached: ${currentSize} matches in buffer (threshold: ${threshold})`
    );
  }

  /**
   * Called when buffer size exceeds the disk spill threshold
   */
  onDiskSpillNeeded(matches: Match[]): void {
    this.diskService.flush(matches).catch((error) => {
      console.error('[RetryService] Failed to flush matches to disk:', error);
    });
  }

  /**
   * Shutdown the retry service
   *
   * Clears all timers. Caller should flush unpublished matches to disk separately.
   */
  shutdown(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.retryAttempts.clear();
    this.inFlight.clear();
  }

  /**
   * Get the number of matches currently scheduled for retry
   */
  get pendingRetryCount(): number {
    return this.retryTimers.size;
  }
}
