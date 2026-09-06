import 'dotenv/config'; // must be first - loads .env before anything reads it
import app from './app.js';
import { env } from './config/env.js';
import logger from './utils/logger.js';

app.listen(env.PORT, () => {
  logger.info(`Server running in ${env.NODE_ENV} mode on http://localhost:${env.PORT}`);
});
