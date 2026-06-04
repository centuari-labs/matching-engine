/**
 * H1: NATS/Redis ingress must be authenticated at the app layer in production.
 *
 * These tests exercise the fail-fast startup assertions in isolation. They must
 * NOT change dev behaviour: with NODE_ENV unset / not 'production', missing
 * credentials are tolerated.
 */

import { assertNatsAuthConfigured } from '../services/nats-service';
import { assertRedisAuthConfigured } from '../services/redis-service';
import type { NatsConfig } from '../config/nats-config';
import type { RedisConfig } from '../config/redis-config';

function natsConfig(overrides: Partial<NatsConfig> = {}): NatsConfig {
  return {
    url: 'nats://localhost:4222',
    maxReconnectAttempts: 10,
    reconnectTimeWait: 2000,
    timeout: 10000,
    ...overrides,
  };
}

function redisConfig(overrides: Partial<RedisConfig> = {}): RedisConfig {
  return {
    url: 'redis://localhost:6379',
    db: 0,
    maxReconnectAttempts: 10,
    reconnectTimeWait: 2000,
    timeout: 10000,
    tls: false,
    ...overrides,
  };
}

describe('H1: bus auth assertions', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('assertNatsAuthConfigured', () => {
    it('throws in production when no credentials are configured', () => {
      process.env.NODE_ENV = 'production';
      expect(() => assertNatsAuthConfigured(natsConfig())).toThrow(
        /NATS authentication is required in production/
      );
    });

    it('passes in production with user + password', () => {
      process.env.NODE_ENV = 'production';
      expect(() =>
        assertNatsAuthConfigured(natsConfig({ user: 'svc', password: 'secret' }))
      ).not.toThrow();
    });

    it('passes in production with a token', () => {
      process.env.NODE_ENV = 'production';
      expect(() => assertNatsAuthConfigured(natsConfig({ token: 'tok' }))).not.toThrow();
    });

    it('throws in production with a username but no password (partial creds)', () => {
      process.env.NODE_ENV = 'production';
      expect(() => assertNatsAuthConfigured(natsConfig({ user: 'svc' }))).toThrow();
    });

    it('does not throw outside production even with no credentials', () => {
      process.env.NODE_ENV = 'development';
      expect(() => assertNatsAuthConfigured(natsConfig())).not.toThrow();
    });
  });

  describe('assertRedisAuthConfigured', () => {
    it('throws in production when no password is configured', () => {
      process.env.NODE_ENV = 'production';
      expect(() => assertRedisAuthConfigured(redisConfig())).toThrow(
        /Redis authentication is required in production/
      );
    });

    it('passes in production with a password', () => {
      process.env.NODE_ENV = 'production';
      expect(() => assertRedisAuthConfigured(redisConfig({ password: 'secret' }))).not.toThrow();
    });

    it('does not throw outside production even with no password', () => {
      process.env.NODE_ENV = 'test';
      expect(() => assertRedisAuthConfigured(redisConfig())).not.toThrow();
    });
  });
});
