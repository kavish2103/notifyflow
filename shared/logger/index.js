const winston = require('winston');
const { AsyncLocalStorage } = require('async_hooks');

// Create an AsyncLocalStorage instance to store request context across async calls.
// This works like Thread-Local Storage (TLS) but is designed for Node.js async event loops.
const loggerStore = new AsyncLocalStorage();

/**
 * Winston Formatter: Auto-inject context from AsyncLocalStorage.
 * Intercepts the logging payload and merges stored context variables into the log metadata.
 */
const contextFormatter = winston.format((info) => {
  const store = loggerStore.getStore();
  if (store) {
    if (store.correlationId && !info.correlationId) {
      info.correlationId = store.correlationId;
    }
    if (store.tenantId && !info.tenantId) {
      info.tenantId = store.tenantId;
    }
    if (store.userId && !info.userId) {
      info.userId = store.userId;
    }
  }

  // Ensure timestamps are consistently added in ISO format
  info.timestamp = new Date().toISOString();

  return info;
});

// Configure Winston Logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    contextFormatter(),
    winston.format.json() // Strictly output as single-line JSON string
  ),
  defaultMeta: {
    service: process.env.SERVICE_NAME || 'unnamed-service'
  },
  transports: [
    new winston.transports.Console()
  ]
});

/**
 * Express Middleware: Captures and propagates the transaction correlation identity.
 * Reads the incoming HTTP headers or generates a new trace ID if entering at the Gateway edge.
 */
const expressLoggerMiddleware = (req, res, next) => {
  // Capture correlation ID from headers or generate one
  const correlationId = req.headers['x-correlation-id'] || `req-${Math.random().toString(36).substring(2, 11)}`;
  const tenantId = req.headers['x-tenant-id'] || null;

  const context = { correlationId, tenantId };

  // Run the request execution path inside the AsyncLocalStorage scope
  loggerStore.run(context, () => {
    next();
  });
};

module.exports = {
  logger,
  loggerStore,
  expressLoggerMiddleware
};
