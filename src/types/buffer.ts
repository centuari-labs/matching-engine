/**
 * Buffer Types
 *
 * Defines types and interfaces for the match buffer management system.
 * These types keep the core execution engine decoupled from retry/persistence logic.
 */

import type { Match } from './matches';

/**
 * Statistics about the in-memory match buffer
 */
export interface BufferStats {
  /** Total number of matches currently in memory */
  totalMatches: number;
  /** Number of matches actively being retried */
  retryingCount: number;
  /** Age of the oldest match in milliseconds (0 if buffer is empty) */
  oldestMatchAge: number;
  /** Highest warning threshold currently breached, or null if none */
  thresholdBreached: number | null;
}

/**
 * Event handler interface for buffer lifecycle events
 *
 * Implementations handle retry scheduling, threshold alerts, and disk persistence.
 * This abstraction keeps the core ExecutionEngine free of I/O concerns.
 */
export interface BufferEventHandler {
  /** Called when a match fails to publish to the settlement publisher */
  onPublishFailed(match: Match): void;
  /** Called when a match is successfully published and removed from the buffer */
  onPublishSucceeded(matchId: string): void;
  /** Called when buffer size crosses a warning threshold */
  onThresholdBreached(currentSize: number, threshold: number): void;
  /** Called when buffer size exceeds the disk spill threshold */
  onDiskSpillNeeded(matches: Match[]): void;
}
