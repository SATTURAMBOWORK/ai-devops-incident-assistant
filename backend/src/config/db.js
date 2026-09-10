import mongoose from 'mongoose';
import { env } from './env.js';
import logger from '../utils/logger.js';

// Mongoose queues operations until it connects. Left on, a bad connection string
// makes requests hang for 30s instead of failing. Off, they error immediately -
// which is what we want, because a fast failure is a debuggable failure.
mongoose.set('bufferCommands', false);

export async function connectDB() {
  // Connection-level events. Registered before connecting so nothing is missed.
  mongoose.connection.on('connected', () =>
    logger.info(`MongoDB connected to database "${mongoose.connection.name}"`)
  );
  mongoose.connection.on('error', (err) => logger.error('MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  await mongoose.connect(env.MONGO_URI, {
    // Set here rather than in the URI, so the string copied from Atlas works
    // unmodified. Without a database name Mongoose silently uses "test".
    dbName: env.MONGO_DB_NAME,
    // Default is 30s. Ten is long enough for a real connection and short enough
    // that a wrong password or a missing IP whitelist tells you quickly.
    serverSelectionTimeoutMS: 10000,
  });

  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.connection.close();
}

// 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting.
// The health route turns this into an HTTP status.
export function getDBState() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return states[mongoose.connection.readyState] ?? 'unknown';
}
