// The ONLY module that touches process.env.
// Everything else imports `env` from here, so there is one place to look
// when you ask "what configuration does this app take?".
export const env = {
  PORT: Number(process.env.PORT) || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',

  MONGO_URI: process.env.MONGO_URI,
  MONGO_DB_NAME: process.env.MONGO_DB_NAME || 'incident-assistant',

  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,

  // Our own ML service (ml/main.py). Not in assertEnv below on purpose: the
  // classifier is optional, so a missing URL degrades one feature instead of
  // stopping the app from booting. The default is the local dev port; in
  // docker-compose it becomes http://ml-service:8000.
  ML_SERVICE_URL: process.env.ML_SERVICE_URL || 'http://localhost:8000',
};

// Fail loudly at startup rather than mysteriously on the first request.
// A missing secret should never get as far as a user-facing 500.
export function assertEnv() {
  const missing = ['MONGO_URI', 'VOYAGE_API_KEY', 'GROQ_API_KEY'].filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
