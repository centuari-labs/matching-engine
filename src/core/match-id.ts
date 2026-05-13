import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

/**
 * ⚠️ LOAD-BEARING CONSTANT — DO NOT REGENERATE.
 *
 * This UUID namespace is the seed for every deterministic matchId we
 * produce. Changing this value invalidates the derivation for all
 * post-fix matches and breaks settlement-engine deduplication on-chain.
 *
 * Generated via `uuidgen` on 2026-05-13.
 */
export const MATCH_ID_NAMESPACE = '6697f9f3-58f4-4c55-af1a-3bbd3ef8e17b' as const;

// Validate at module load — fail fast on a fat-finger paste/typo so this
// can never silently degrade to a non-UUID.
z.string().uuid().parse(MATCH_ID_NAMESPACE);

/**
 * Inputs to `deriveMatchId`.
 *
 * Each field MUST be a canonical decimal string (no leading zeros, no
 * whitespace, no signs) for amount-shaped values. Upstream callers
 * already guarantee this via Zod schemas and `subtractBigNumbers`.
 *
 * Note: `marketId` is intentionally NOT in the seed. Order ids are
 * globally unique UUIDs, so `(lendOrderId, borrowOrderId)` already
 * uniquely identifies the maker/taker pair. Adding `marketId` would
 * invite footguns (different string representations across callsites
 * producing different ids for the same match).
 */
export interface DeriveMatchIdParams {
  readonly lendOrderId: string;
  readonly borrowOrderId: string;
  readonly matchedAmount: string;
  readonly lendRemainingAfter: string;
  readonly borrowRemainingAfter: string;
}

/**
 * Derive a deterministic UUID v5 matchId from the match state.
 *
 * Collision-free across legitimate scenarios because remaining-after
 * tuples are monotonically non-increasing (no top-up exists) — for any
 * (lendOrderId, borrowOrderId) pair, each fill leaves a distinct
 * (matchedAmount, lendRemainingAfter, borrowRemainingAfter) triple.
 *
 * The full seed is the colon-joined string of all params in order.
 * Two distinct matches cannot share a seed without the underlying
 * orderbook state having repeated — which cannot happen.
 *
 * @param params - Match state inputs
 * @returns A UUID v5 string suitable for storage as matchId
 */
export function deriveMatchId(params: DeriveMatchIdParams): string {
  const seed = [
    params.lendOrderId,
    params.borrowOrderId,
    params.matchedAmount,
    params.lendRemainingAfter,
    params.borrowRemainingAfter,
  ].join(':');
  return uuidv5(seed, MATCH_ID_NAMESPACE);
}
