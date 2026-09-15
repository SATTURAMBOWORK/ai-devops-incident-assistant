import { env } from '../config/env.js';
import logger from '../utils/logger.js';

// The only file that talks to the Python ML service (ml/main.py).
//
// That service runs a classifier we trained ourselves on labelled incident logs
// (see ml/train.py). It answers one narrow question - "which runbook category
// do these logs belong to?" - and it answers it in milliseconds, offline, with
// no API cost.
//
// This is a different kind of signal from the other two services:
//   embedding.service  - semantic similarity, needs a paid API
//   analysis.service   - an LLM writing prose, needs a paid API, seconds
//   classifier.service - our own trained model, free, instant
//
// Having a cheap, local second opinion is worth a lot: when it agrees with
// retrieval we can be more confident, and when it disagrees that is a signal in
// itself.

// The classifier is a small linear model; a prediction takes a few
// milliseconds. If it has not answered in two seconds something is wrong, and
// we would rather drop the extra signal than hold up the whole analysis.
const TIMEOUT_MS = 2000;

// Below this the model is guessing rather than recognising. ml/predict.py
// already returns no predictions when its best guess is under 0.40, so today
// this is a second safety net: it keeps the backend's own bar in place if the
// ML service's floor is ever lowered.
const MIN_CONFIDENCE = 0.25;

/**
 * Ask the ML service which runbook category these logs look like.
 *
 * Deliberately never throws. The classifier is a *supplementary* signal, not a
 * required one - the app produced complete analyses before it existed. If the
 * service is down, misconfigured or slow, the incident analysis must still
 * work, just without this extra hint. Compare embedding.service.js, which does
 * throw: without embeddings there is no retrieval and no RAG at all.
 *
 * @param {string} logs
 * @returns {Promise<{ label: string, confidence: number, alternatives: Array<{label: string, confidence: number}>, modelVersion: string } | null>}
 *   null when the service is unavailable or too unsure to be useful.
 */
export async function classifyLogs(logs) {
  try {
    const res = await fetch(`${env.ML_SERVICE_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.warn(`Classifier returned ${res.status}, continuing without it`);
      return null;
    }

    const body = await res.json();
    const [top, ...rest] = body.predictions ?? [];

    // No prediction cleared the service's own floor: the logs look like nothing
    // the model was trained on.
    if (!top) return null;

    // The model answered, but without conviction. Reporting a coin-flip as a
    // category would be worse than staying quiet - an on-call engineer who is
    // pointed at the wrong runbook loses more time than one given no hint.
    if (top.confidence < MIN_CONFIDENCE) {
      logger.info(`Classifier unsure (${top.label} at ${top.confidence}), ignoring`);
      return null;
    }

    return {
      label: top.label,
      confidence: top.confidence,
      alternatives: rest,
      modelVersion: body.model_version,
    };
  } catch (err) {
    // Timeout, connection refused, bad JSON - all the same to us: no signal.
    // info, not error: this is an expected, handled degradation, and logging it
    // as an error would train you to ignore real errors.
    logger.info(`Classifier unavailable (${err.message}), continuing without it`);
    return null;
  }
}
