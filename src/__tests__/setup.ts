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
