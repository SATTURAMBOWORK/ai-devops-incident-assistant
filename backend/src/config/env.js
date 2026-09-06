// The ONLY module that touches process.env.
// Everything else imports `env` from here, so there is one place to look
// when you ask "what configuration does this app take?".
export const env = {
  PORT: Number(process.env.PORT) || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',
};
