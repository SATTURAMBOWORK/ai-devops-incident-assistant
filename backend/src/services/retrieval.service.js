import { runbook } from '../knowledge/runbook.js';
import { embedTexts } from './embedding.service.js';
import logger from '../utils/logger.js';

// The "R" in RAG: given some logs, find the runbook entries that describe the
// same kind of problem.
//
// Deliberately no vector database. With a handful of entries, comparing against
// every one of them in memory takes microseconds. A vector DB earns its place at
// thousands of documents, not eight.

// How many entries to hand to the LLM. More than 3 mostly adds noise and tokens.
const TOP_K = 3;

// Two filters, tuned with scripts/try-retrieval.js (correct matches scored
// 0.59-0.74, wrong ones up to 0.55, healthy logs at most 0.35):
//
// MIN_SCORE - an absolute floor. Below it an entry is unrelated, and feeding the
// LLM an unrelated runbook is worse than feeding it nothing.
const MIN_SCORE = 0.55;
// MAX_GAP - a relative filter. Keep only entries close to the best match, so a
// clear winner (0.74) is not padded with weak runners-up (0.55). One fixed
// threshold alone cannot do this: a good match for vague logs can score lower
// than a bad match for very specific ones.
const MAX_GAP = 0.1;

// The runbook vectors, created once and reused for every request. We store the
// *promise* rather than the result so that if two requests arrive before the
// first embedding call finishes, they share it instead of calling Voyage twice.
let indexPromise = null;

async function buildIndex() {
  // Embed title + symptoms: that is what an incident "looks like". The steps
  // describe the fix, not the problem, so they would only blur the match.
  const texts = runbook.map((entry) => `${entry.title}. ${entry.symptoms}`);
  const { vectors, tokens } = await embedTexts(texts, 'document');

  logger.info(`Runbook index ready: ${runbook.length} entries embedded (${tokens} tokens)`);
  return runbook.map((entry, i) => ({ entry, vector: vectors[i] }));
}

function getIndex() {
  if (!indexPromise) {
    indexPromise = buildIndex().catch((err) => {
      // Don't cache a failure - let the next request try again.
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

// Called at server startup so the first user doesn't pay for building the index.
// Safe to skip: retrieve() builds it on demand anyway.
export const initRetrieval = getIndex;

// Cosine similarity: how closely two vectors point in the same direction.
// 1 = same meaning, 0 = unrelated. It ignores vector length, so a long log and
// a short runbook entry can still score as a strong match.
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Find the runbook entries most relevant to some logs.
 *
 * @param {string} logs
 * @returns {Promise<Array<{ id: string, title: string, steps: string[], score: number }>>}
 *   Best match first. Empty if nothing is similar enough.
 */
export async function retrieve(logs) {
  const index = await getIndex();
  const { vectors } = await embedTexts([logs], 'query');
  const logVector = vectors[0];

  const matches = index
    .map(({ entry, vector }) => ({
      id: entry.id,
      title: entry.title,
      steps: entry.steps,
      score: Number(cosineSimilarity(logVector, vector).toFixed(3)),
    }))
    .filter((match) => match.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  if (matches.length === 0) return [];

  const best = matches[0].score;
  return matches.filter((match) => best - match.score <= MAX_GAP).slice(0, TOP_K);
}
