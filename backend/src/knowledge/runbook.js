// The knowledge base for RAG: a small runbook of known incident patterns.
//
// Each entry has:
//   id       - stable identifier, handy for logs and tests
//   title    - short name, stored on the Incident as `retrievedDocs.title`
//   symptoms - what this incident looks like in logs/metrics. This is the text
//              that gets embedded, so it deliberately includes the exact error
//              strings and codes that show up in real logs.
//   steps    - documented troubleshooting procedure, passed to the LLM as context
//
// It is plain code rather than a database collection: it is small, changes only
// when a developer edits it, and is version-controlled alongside the code.
export const runbook = [
  {
    id: 'oom-killed',
    title: 'Container killed: out of memory',
    symptoms:
      'Process or container killed for exceeding its memory limit. Logs show OOMKilled, exit code 137, "JavaScript heap out of memory", "FATAL ERROR: Reached heap limit", or "Killed". Memory usage near 100% before the crash, often followed by a restart.',
    steps: [
      'Confirm with `docker inspect <container>` (State.OOMKilled: true) or `kubectl describe pod` (Reason: OOMKilled).',
      'Check memory usage over time for a steady climb (leak) versus a sudden spike (large request or batch job).',
      'For Node.js, compare --max-old-space-size with the container memory limit; the heap limit must be lower.',
      'Short term: raise the memory limit. Long term: take a heap snapshot and fix the leak or stream large payloads.',
    ],
  },
  {
    id: 'db-connection-refused',
    title: 'Database connection failure',
    symptoms:
      'Application cannot connect to its database. Logs show ECONNREFUSED, ETIMEDOUT, "MongoServerSelectionError", "MongoNetworkError", "connection refused" on port 27017, 5432 or 3306, "authentication failed", or "too many connections". Requests fail with 500 errors.',
    steps: [
      'Check the database is running and reachable from the app host (`nc -zv <host> <port>`).',
      'Verify the connection string, username and password in the environment variables.',
      'For MongoDB Atlas, confirm the app IP is in the Network Access allowlist.',
      'If "too many connections", check the connection pool size and look for connections that are never closed.',
    ],
  },
  {
    id: 'disk-full',
    title: 'Disk space exhausted',
    symptoms:
      'Writes fail because the disk or volume is full. Logs show ENOSPC, "No space left on device", "disk quota exceeded", or database write errors. Log files or Docker images grow without limit.',
    steps: [
      'Find what is using space: `df -h`, then `du -sh /var/log/* | sort -h`.',
      'Clean up Docker: `docker system df`, then `docker system prune` for unused images and containers.',
      'Enable log rotation (logrotate, or Docker `--log-opt max-size`).',
      'Add a disk usage alert, for example at 80%.',
    ],
  },
  {
    id: 'port-in-use',
    title: 'Port already in use',
    symptoms:
      'Server fails to start because its port is taken. Logs show EADDRINUSE, "address already in use", "bind: address already in use", or "port is already allocated". The process exits immediately on startup.',
    steps: [
      'Find the process holding the port: `lsof -i :<port>` (Linux/macOS) or `netstat -ano | findstr :<port>` (Windows).',
      'Stop the old instance, often a previous run that did not shut down cleanly.',
      'For Docker, check `docker ps` for another container publishing the same host port.',
      'Make the port configurable through an environment variable.',
    ],
  },
  {
    id: 'crash-loop',
    title: 'Application crash loop on startup',
    symptoms:
      'Application starts, crashes, and is restarted repeatedly. Logs show CrashLoopBackOff, "Back-off restarting failed container", "exited with code 1", unhandled exceptions or "Cannot find module" right after startup, or missing environment variable errors.',
    steps: [
      'Read the logs from the previous run: `kubectl logs <pod> --previous` or `docker logs <container>`.',
      'Look for the first error after startup; later errors are usually consequences of it.',
      'Check required environment variables and secrets are set in this environment.',
      'Check the latest deployment for a bad build, missing dependency or wrong start command, and roll back if needed.',
    ],
  },
  {
    id: 'ssl-cert-expired',
    title: 'SSL/TLS certificate problem',
    symptoms:
      'HTTPS connections fail. Logs show CERT_HAS_EXPIRED, "certificate has expired", UNABLE_TO_VERIFY_LEAF_SIGNATURE, "self signed certificate", "x509: certificate", or "SSL handshake failed".',
    steps: [
      'Check the certificate dates: `openssl s_client -connect <host>:443 | openssl x509 -noout -dates`.',
      'Renew the certificate (for Let\'s Encrypt: `certbot renew`) and reload the web server.',
      'If the error is on an outgoing call, make sure the CA bundle in the container is up to date.',
      'Set up automatic renewal and an expiry alert.',
    ],
  },
  {
    id: 'high-latency',
    title: 'High latency and request timeouts',
    symptoms:
      'Requests become slow or time out. Logs show "504 Gateway Timeout", "upstream timed out", "request timeout", ETIMEDOUT on outgoing calls, or slow query warnings. CPU usage is high or request count has spiked.',
    steps: [
      'Check whether latency matches a traffic spike (request count) or a resource limit (CPU, memory).',
      'Find the slow dependency: database slow query log, or timing of outgoing API calls.',
      'Look for missing database indexes on frequently queried fields.',
      'Scale out or add caching for hot endpoints; set timeouts on every outgoing call.',
    ],
  },
  {
    id: 'error-rate-spike',
    title: 'Spike in 5xx errors after a deployment',
    symptoms:
      'Error rate jumps suddenly, often right after a release. Logs show many "500 Internal Server Error" or "502 Bad Gateway" responses, TypeError or "undefined is not a function" stack traces, or failed health checks.',
    steps: [
      'Compare the time errors started with the most recent deployment.',
      'Group errors by endpoint and stack trace to find the single failing code path.',
      'If a deployment is the cause, roll back first and investigate afterwards.',
      'Add a test covering the failure before redeploying the fix.',
    ],
  },
];
