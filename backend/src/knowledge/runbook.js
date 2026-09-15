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
      'Application starts, crashes, and is restarted repeatedly with no clearer cause in the logs. Logs show CrashLoopBackOff, "Back-off restarting failed container", "exited with code 1", restart counts climbing, or an unhandled exception right after startup.',
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

  // The five entries below were split out so each names a root cause, not a
  // symptom. A crash loop CAUSED by a missing env var is 'missing-config', and
  // 'crash-loop' above is left for restarts with no clearer cause. Keeping the
  // symptoms of different entries apart matters twice: retrieval embeds this
  // text, and the classifier in ml/ is trained on the same category ids.
  {
    id: 'dns-resolution-failure',
    title: 'DNS resolution failure',
    symptoms:
      'A hostname cannot be resolved to an address, so the connection is never attempted. Logs show ENOTFOUND, EAI_AGAIN, "getaddrinfo ENOTFOUND", "querySrv ENOTFOUND", "Temporary failure in name resolution", "could not resolve host", NXDOMAIN or UnknownHostException.',
    steps: [
      'Check the exact hostname in the error for typos and for the wrong environment (for example a staging host in production).',
      'Resolve it from inside the container, not your laptop: `docker exec <container> nslookup <host>` or `getent hosts <host>`.',
      'In Docker Compose, use the service name as the hostname and confirm both services are on the same network.',
      'For EAI_AGAIN (temporary), check the DNS server in /etc/resolv.conf and retry with backoff; for ENOTFOUND, fix the name or the DNS record.',
    ],
  },
  {
    id: 'permission-denied',
    title: 'Permission denied',
    symptoms:
      'The process is not allowed to read, write or bind to something. Logs show EACCES, EPERM, "Permission denied", "operation not permitted", "listen EACCES" on a port below 1024, or "Access denied" on a file, directory or mounted volume.',
    steps: [
      'Find which path or port was denied in the error, and which user the process runs as (`docker exec <container> id`).',
      'Check ownership and mode of the path: `ls -ld <path>`; for mounted volumes, the host directory owner must match the container user.',
      'For ports below 1024, run on a higher port (e.g. 3000) and map it, instead of running the container as root.',
      'Fix ownership in the Dockerfile (`COPY --chown`, `chown` before `USER`) rather than making files world-writable.',
    ],
  },
  {
    id: 'missing-config',
    title: 'Missing configuration or dependency',
    symptoms:
      'The application fails because something it expects at startup is absent. Logs show a required environment variable "is not set" or "undefined", "Cannot find module", ModuleNotFoundError, "No such file or directory" for a config file, "Missing script: start", or a missing secret.',
    steps: [
      'Read the first error after startup: it names the missing variable, file or module.',
      'Compare the environment with .env.example: `docker exec <container> env` or `kubectl describe pod` for env and secrets.',
      'For a missing module, check it is in dependencies (not devDependencies) and that the image runs `npm ci` or `pip install`.',
      'Validate required configuration at startup and fail with a clear message listing what is missing.',
    ],
  },
  {
    id: 'too-many-open-files',
    title: 'Too many open files',
    symptoms:
      'The process has used up its file descriptor limit, so new files and sockets cannot be opened. Logs show EMFILE, "too many open files", "Too many open files in system", "accept: too many open files", or ENFILE, often while under load.',
    steps: [
      'Check the limit and current usage: `ulimit -n` and `ls /proc/<pid>/fd | wc -l` inside the container.',
      'Look for leaks - sockets, file streams or HTTP clients created per request and never closed.',
      'Reuse connections: one database pool and one HTTP agent with keep-alive, not a new one per request.',
      'Raise the limit only after fixing leaks: Docker `--ulimit nofile=65536:65536` or `ulimits` in Compose.',
    ],
  },
  {
    id: 'auth-brute-force',
    title: 'Brute-force login attempts',
    symptoms:
      'Many failed logins in a short time, usually from a few IP addresses trying common user names. Logs show repeated "Failed password for", "Invalid user", "authentication failure", "Too many authentication failures", "POSSIBLE BREAK-IN ATTEMPT", or HTTP 401 responses on a login endpoint.',
    steps: [
      'Group failures by source IP and user name to confirm it is an attack and not one user with a wrong password.',
      'Check whether any attempt succeeded ("Accepted password" from the same IP) - if so, treat it as a breach.',
      'Block the offending IPs and add rate limiting or fail2ban for the login endpoint or SSH.',
      'Disable SSH password login in favour of keys, and require strong passwords or MFA for application logins.',
    ],
  },
];
