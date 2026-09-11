import { runbook } from '../../src/knowledge/runbook.js';

// Fake responses for the external APIs, shared by the test files. Tests replace
// the global `fetch` with these, so they never call Voyage or Groq: no API keys,
// no rate limits, no cost, and failures can be simulated on demand.
//
// Not a test file itself - the test glob only matches *.test.js.

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- Voyage ----------

// Every fake query embeds to this vector...
export const QUERY_VECTOR = [1, 0];

// ...and this builds a document vector whose cosine similarity with it is
// exactly `score`. That lets a test say "the OOM entry scores 0.8" directly.
export function vectorWithScore(score) {
  return [score, Math.sqrt(1 - score ** 2)];
}

// Similarity scores for the runbook, in runbook order.
// runbookScores({ 'oom-killed': 0.8 }) -> 0.8 for that entry, 0.3 for the rest.
export function runbookScores(overrides, fallback = 0.3) {
  return runbook.map((entry) => overrides[entry.id] ?? fallback);
}

export function voyageResponse(vectors) {
  return jsonResponse({
    data: vectors.map((embedding, index) => ({ embedding, index })),
    usage: { total_tokens: 10 },
  });
}

// A fake fetch that answers like Voyage: runbook documents get the given
// scores, and any query gets QUERY_VECTOR.
export function fakeVoyage(scores) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.input_type === 'document') {
      return voyageResponse(scores.map(vectorWithScore));
    }
    return voyageResponse(body.input.map(() => QUERY_VECTOR));
  };
}

// ---------- Groq ----------

export const SAMPLE_ANALYSIS = {
  summary: 'The api container crashed after running out of memory.',
  rootCause: 'JavaScript heap exhausted, container OOM-killed (exit code 137).',
  evidence: ['FATAL ERROR: JavaScript heap out of memory', 'exited with code 137'],
  severity: 'HIGH',
  steps: ['Confirm OOMKilled with docker inspect', 'Raise the memory limit'],
  confidence: 90,
};

export function groqResponse(content = JSON.stringify(SAMPLE_ANALYSIS), { finishReason = 'stop' } = {}) {
  return jsonResponse({
    model: 'openai/gpt-oss-120b',
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { total_tokens: 1000 },
  });
}
