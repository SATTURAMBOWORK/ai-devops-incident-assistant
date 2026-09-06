import logger from '../utils/logger.js';
import { env } from '../config/env.js';

// Thrown by our own code when we know what went wrong and what status it maps to.
export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Reached only if no route matched - Express runs middleware in order.
export function notFound(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
}

// Express treats a 4-argument middleware as the error handler. Every failure in
// the app funnels through here, so the JSON error shape is defined exactly once.
export function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';

  if (statusCode >= 500) logger.error(err.message, err.stack);
  else logger.warn(`${statusCode} ${code}: ${err.message}`);

  res.status(statusCode).json({
    success: false,
    error: {
      message: err.message || 'Something went wrong',
      code,
      // Stack traces help while developing but leak internals in production.
      ...(env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
}
