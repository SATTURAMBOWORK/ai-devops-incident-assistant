// A tiny logger with timestamps. Deliberately not a library - swapping in
// pino later is a one-file change, and this keeps the dependency list short.
const stamp = () => new Date().toISOString();

export default {
  info: (...args) => console.log(`[${stamp()}] INFO `, ...args),
  warn: (...args) => console.warn(`[${stamp()}] WARN `, ...args),
  error: (...args) => console.error(`[${stamp()}] ERROR`, ...args),
};
