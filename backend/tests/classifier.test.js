import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLogs } from '../src/services/classifier.service.js';
import { jsonResponse } from './helpers/fakes.js';

// Unit tests for the ML classifier client. The Python service is faked, so
// these tests need no running container, no model file and no Python at all.
//
// Almost every test here is about the SAD path. That is deliberate: the value
// of classifier.service.js is not that it can parse a successful response, it
// is that nothing it touches can ever break an incident analysis. Those are the
// cases worth locking down.

// A response shaped like ml/main.py's PredictResponse.
const mlResponse = (predictions, modelVersion = 'tfidf-logreg-1.0.0') =>
  jsonResponse({ predictions, model_version: modelVersion });

afterEach(() => mock.restoreAll());

describe('classifyLogs', () => {
  it('returns the top prediction with its alternatives', async () => {
    mock.method(globalThis, 'fetch', async () =>
      mlResponse([
        { label: 'oom-killed', confidence: 0.62 },
        { label: 'crash-loop', confidence: 0.14 },
      ])
    );

    const result = await classifyLogs('FATAL ERROR: heap out of memory, exit code 137');

    assert.equal(result.label, 'oom-killed');
    assert.equal(result.confidence, 0.62);
    assert.deepEqual(result.alternatives, [{ label: 'crash-loop', confidence: 0.14 }]);
    assert.equal(result.modelVersion, 'tfidf-logreg-1.0.0');
  });

  it('sends the logs as JSON to the /predict endpoint', async () => {
    let seenUrl;
    let seenBody;
    mock.method(globalThis, 'fetch', async (url, options) => {
      seenUrl = url;
      seenBody = JSON.parse(options.body);
      return mlResponse([{ label: 'disk-full', confidence: 0.9 }]);
    });

    await classifyLogs('ENOSPC: no space left on device');

    assert.ok(seenUrl.endsWith('/predict'), `unexpected url: ${seenUrl}`);
    assert.deepEqual(seenBody, { logs: 'ENOSPC: no space left on device' });
  });

  // ---------- the cases that must never throw ----------

  it('returns null when the prediction is below MIN_CONFIDENCE', async () => {
    // The model answered, but it is barely more sure than a coin flip.
    // Pointing an on-call engineer at the wrong runbook is worse than silence.
    mock.method(globalThis, 'fetch', async () =>
      mlResponse([{ label: 'error-rate-spike', confidence: 0.17 }])
    );

    assert.equal(await classifyLogs('something ambiguous'), null);
  });

  it('returns null when the service returns no predictions at all', async () => {
    mock.method(globalThis, 'fetch', async () => mlResponse([]));

    assert.equal(await classifyLogs('nothing recognisable here'), null);
  });

  it('returns null when the service is unreachable', async () => {
    // The whole point of the service: the ML container being down is a normal
    // operating state, not an error the user should ever see.
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });

    assert.equal(await classifyLogs('FATAL ERROR: heap out of memory'), null);
  });

  it('returns null when the model is not loaded (503)', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse({ detail: 'Model not loaded.' }, 503)
    );

    assert.equal(await classifyLogs('exit code 137'), null);
  });

  it('returns null when the service sends a malformed body', async () => {
    mock.method(globalThis, 'fetch', async () => new Response('not json', { status: 200 }));

    assert.equal(await classifyLogs('exit code 137'), null);
  });

  it('returns null when the request times out', async () => {
    // AbortSignal.timeout rejects with an AbortError; it must be caught like
    // any other failure rather than propagating into the analysis flow.
    mock.method(globalThis, 'fetch', async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });

    assert.equal(await classifyLogs('exit code 137'), null);
  });
});
