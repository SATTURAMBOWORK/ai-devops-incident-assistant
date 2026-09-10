import 'dotenv/config'; // must be first - retrieval needs VOYAGE_API_KEY
import { retrieve } from '../src/services/retrieval.service.js';

// Manual check for RAG retrieval: run sample logs through retrieve() and print
// what comes back. Not an automated test - it calls the real Voyage API - but it
// is how we see whether matches are correct and whether MIN_SCORE is sensible.
//
// Run from backend/:  node scripts/try-retrieval.js

const samples = [
  {
    name: 'Node heap out of memory (expect: out of memory)',
    logs: `2026-09-10T10:02:11Z api-1  <--- Last few GCs --->
2026-09-10T10:02:11Z api-1  FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
2026-09-10T10:02:12Z docker  container api-1 exited with code 137`,
  },
  {
    name: 'MongoDB unreachable (expect: database connection)',
    logs: `[2026-09-10 10:15:40] ERROR MongoServerSelectionError: connect ECONNREFUSED 10.0.0.5:27017
[2026-09-10 10:15:41] ERROR GET /api/orders 500 - database unavailable`,
  },
  {
    name: 'Same OOM problem, no keywords (tests meaning, not words)',
    logs: `worker process was terminated by the kernel because the cgroup memory limit was reached; supervisor restarted it`,
  },
  {
    name: 'Healthy logs (expect: nothing, or only weak matches)',
    logs: `[2026-09-10 11:00:00] INFO GET /api/health 200 3ms
[2026-09-10 11:00:05] INFO user 42 logged in
[2026-09-10 11:00:09] INFO GET /api/products 200 18ms`,
  },
];

// Without a payment method, Voyage allows only 3 requests per minute. Building
// the index is 1 request and each sample is 1 more, so wait before every sample
// - including the first, which would otherwise fire right after the index.
const PAUSE_MS = 30000;

for (const sample of samples) {
  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  const matches = await retrieve(sample.logs);

  console.log(`\n${sample.name}`);
  if (matches.length === 0) {
    console.log('  (no runbook entry above the minimum score)');
  }
  for (const match of matches) {
    console.log(`  ${match.score.toFixed(3)}  ${match.title}`);
  }
}
