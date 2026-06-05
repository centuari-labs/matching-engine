import pino from 'pino';

const isDev = process.env.NODE_ENV === 'development';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Global safety net: never emit credentials even if a log site forgets to
  // mask them. Covers raw connection URLs (which may embed `user:pass@host`)
  // and discrete secret fields. Use `maskUrl` at log sites for the readable
  // `scheme://host` form; this redact is the last line of defence.
  redact: {
    paths: [
      'url',
      'natsUrl',
      'redisUrl',
      'redisServer',
      'natsServer',
      'password',
      'pass',
      'token',
      'connectionString',
      '*.url',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

export function createLogger(service: string): pino.Logger {
  return logger.child({ service });
}

export default logger;
