import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Schema for fee configuration validation
 */
const feeConfigSchema = z.object({
  /**
   * Maker fee in basis points (100 bps = 1%)
   * Example: 10 bps = 0.1%
   */
  makerFeeBps: z.number().int().min(0).max(10000).default(10),

  /**
   * Taker fee in basis points (100 bps = 1%)
   * Example: 20 bps = 0.2%
   */
  takerFeeBps: z.number().int().min(0).max(10000).default(20),
});

export type FeeConfig = z.infer<typeof feeConfigSchema>;

let cachedFeeConfig: FeeConfig | null = null;

/**
 * Load and validate fee configuration from environment variables.
 * Result is cached for use in the hot path.
 *
 * @returns Validated fee configuration object
 */
export function loadFeeConfig(): FeeConfig {
  if (cachedFeeConfig !== null) {
    return cachedFeeConfig;
  }

  const config = {
    makerFeeBps: process.env.MAKER_FEE_BPS
      ? parseInt(process.env.MAKER_FEE_BPS, 10)
      : 10,
    takerFeeBps: process.env.TAKER_FEE_BPS
      ? parseInt(process.env.TAKER_FEE_BPS, 10)
      : 20,
  };

  const result = feeConfigSchema.safeParse(config);

  if (!result.success) {
    const errorMessages = result.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ');
    throw new Error(`Invalid fee configuration: ${errorMessages}`);
  }

  cachedFeeConfig = result.data;
  return cachedFeeConfig;
}
