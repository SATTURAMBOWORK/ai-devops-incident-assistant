import 'dotenv/config'; // must be first - loads .env before anything reads it
import app from './app.js';
import { env, assertEnv } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import logger from './utils/logger.js';

async function start() {
  assertEnv();

  // Awaited BEFORE listening. The server must not accept traffic it cannot
  // serve - otherwise the first users get 500s while the database dials up.
  await connectDB();

  const server = app.listen(env.PORT, () => {
    logger.info(`Server running in ${env.NODE_ENV} mode on http://localhost:${env.PORT}`);
  });

  // Graceful shutdown: Docker sends SIGTERM when stopping a container. Finish
  // in-flight requests and close the DB rather than being killed mid-write.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      logger.info(`${signal} received, shutting down`);
      server.close(async () => {
        await disconnectDB();
        process.exit(0);
      });
    });
  }
}

start().catch((err) => {
  logger.error('Failed to start server:', err.message);
  process.exit(1); // non-zero tells Docker/CI the container failed
});
