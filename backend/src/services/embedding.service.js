import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';

// The only file that talks to Voyage AI. If we ever switch embedding provider,
// this is the one file that changes - the rest of the app just gets vectors.
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

// voyage-4-lite: cheapest current model, 1024-dimensional vectors. Plenty for
// matching logs against a handful of runbook entries.
export const EMBEDDING_MODEL = 'voyage-4-lite';

// An embedding call normally takes well under a second. Without a timeout, a
// hung request would hold the user's analysis open indefinitely.
const TIMEOUT_MS = 15000;

/**
 * Turn a list of texts into embedding vectors, in the same order.
 *
 * @param {string[]} texts
 * @param {'document' | 'query'} inputType
 *   'document' for the runbook entries we search through,
 *   'query' for the logs we search with. Voyage tunes the vector slightly
 *   differently for each, which improves matching.
 * @returns {Promise<{ vectors: number[][], tokens: number }>}
 */
export async function embedTexts(texts, inputType) {
  let res;
  try {
    res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: texts, // one request for many texts - Voyage accepts a batch
        model: EMBEDDING_MODEL,
        input_type: inputType,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure or timeout: we never got a response at all.
    throw new AppError(`Embedding service unreachable: ${err.message}`, 502, 'EMBEDDING_FAILED');
  }

  if (!res.ok) {
    // Voyage answered with an error (bad key, rate limit, ...). Include its
    // message so the cause is obvious in our logs.
    const detail = await res.text();
    throw new AppError(`Embedding request failed (${res.status}): ${detail}`, 502, 'EMBEDDING_FAILED');
  }

  const body = await res.json();

  // Voyage returns each result with an `index`; sort by it so vectors[i]
  // always belongs to texts[i].
  const vectors = body.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);

  return { vectors, tokens: body.usage.total_tokens };
}
