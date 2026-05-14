// Disable dotenv during tests so config modules don't leak the developer's
// local .env into env-var assertions (e.g. nats-config "should load default
// configuration when no env vars are set" — committed .env values would
// otherwise override the in-test `delete process.env.X`).
jest.mock('dotenv', () => ({
  config: jest.fn(),
  parse: jest.fn(() => ({})),
}));

jest.mock('../utils/logger', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  return {
    __esModule: true,
    default: mockLogger,
    createLogger: jest.fn(() => mockLogger),
  };
});
