/**
 * Connection-string masking helpers.
 *
 * Connection URLs (NATS, Redis, Postgres) frequently embed credentials as
 * `scheme://user:pass@host`. Logging them verbatim leaks secrets into log
 * sinks. `maskUrl` strips any embedded userinfo and returns a safe
 * `scheme://host[:port]` form, falling back to a redacted sentinel when the
 * value cannot be parsed as a URL.
 */

const REDACTED = '[redacted-url]';

/**
 * Strip embedded credentials from a connection URL, returning a log-safe form.
 *
 * - `redis://:secret@host:6379` -> `redis://host:6379`
 * - `nats://user:pass@a:4222,nats://user:pass@b:4222` -> `nats://a:4222,nats://b:4222`
 * - unparseable input -> `[redacted-url]` (never echoes the raw value)
 *
 * @param url - Raw connection URL (may be a comma-separated list)
 * @returns A credential-free representation safe to log
 */
export function maskUrl(url: string | undefined | null): string {
  if (!url) {
    return REDACTED;
  }

  // Support comma-separated server lists (NATS clustering).
  return url
    .split(',')
    .map((part) => maskSingleUrl(part.trim()))
    .join(',');
}

function maskSingleUrl(url: string): string {
  if (!url) {
    return REDACTED;
  }

  try {
    const parsed = new URL(url);
    // `URL.host` includes host + port but never userinfo.
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return REDACTED;
  }
}
