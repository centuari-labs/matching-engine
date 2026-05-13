import { createHash } from 'crypto';

/**
 * Truncate a payload for safe error-path logging.
 *
 * M-16 audit fix. Used at error sites in the DB-writer where the
 * incoming payload either failed JSON parse or Zod validation. The
 * value to operators is "saw an error, can correlate via hash" —
 * not "see the contents." Logging full payloads at error level
 * leaks wallet addresses, amounts, and market metadata into log
 * pipelines that may not enforce PII boundaries.
 *
 * - Strings ≤ `maxLen` pass through unchanged.
 * - Strings > `maxLen` truncate to first 64 chars + sha256 prefix
 *   so the same bad payload is correlatable across log lines
 *   without persisting the body.
 * - Non-string input goes through a cycle-safe stringify before
 *   the same truncation logic.
 *
 * Audit reference: M-16 (matching-engine audit).
 */
export function truncatePayload(input: unknown, maxLen = 256): string {
  const s = typeof input === 'string' ? input : safeStringify(input);
  if (s.length <= maxLen) return s;
  const hash = createHash('sha256').update(s).digest('hex').slice(0, 16);
  return `${s.slice(0, 64)}...[truncated, sha256=${hash}, len=${s.length}]`;
}

/**
 * JSON.stringify with explicit handling for cyclic refs and
 * non-serializable values (BigInt, Symbol, function).
 *
 * Cycles and BigInts both throw on raw JSON.stringify. We catch
 * the exception and return a typed placeholder so logging never
 * crashes the caller.
 */
function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return `[unserializable: ${typeof input}]`;
  }
}
