import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { runbook } from '../src/knowledge/runbook.js';
import { cosineSimilarity } from '../src/services/retrieval.service.js';
import { fakeVoyage, runbookScores, jsonResponse } from './helpers/fakes.js';

// Unit tests for RAG retrieval. Voyage is faked, and the fake vectors are built
// so each runbook entry gets an exact similarity score - which lets us test the
// MIN_SCORE / MAX_GAP / top-3 filtering precisely.

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

// retrieval.service.js caches the runbook index in the module. Importing it with
// a unique query string gives each test a fresh copy, so one test's cached index
// cannot leak into the next.
let copy = 0;
const freshRetrieval = () => import(`../src/services/retrieval.service.js?copy=${++copy}`);

const ids = (matches) => matches.map((m) => m.id);

afterEach(() => mock.restoreAll());

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => close(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1));
  it('is 0 for unrelated (perpendicular) vectors', () => close(cosineSimilarity([1, 0], [0, 1]), 0));
  it('is -1 for opposite vectors', () => close(cosineSimilarity([1, 2], [-1, -2]), -1));
  it('ignores vector length, only direction matters', () => close(cosineSimilarity([1, 2], [2, 4]), 1));
});

describe('retrieve', () => {
  it('returns only entries above MIN_SCORE, with title, steps and score', async () => {
    mock.method(globalThis, 'fetch', fakeVoyage(runbookScores({ 'db-connection-refused': 0.76 })));
    const { retrieve } = await freshRetrieval();

    const matches = await retrieve('MongoServerSelectionError: connect ECONNREFUSED');

    assert.deepEqual(ids(matches), ['db-connection-refused']);
    assert.equal(matches[0].score, 0.76);
    assert.equal(matches[0].title, 'Database connection failure');
    assert.ok(matches[0].steps.length > 0);
  });

  it('drops entries far below the best match (MAX_GAP)', async () => {
    // 0.65 is above MIN_SCORE, but 0.15 behind the best, so it is dropped.
    const scores = runbookScores({ 'oom-killed': 0.8, 'crash-loop': 0.74, 'disk-full': 0.65 });
    mock.method(globalThis, 'fetch', fakeVoyage(scores));
    const { retrieve } = await freshRetrieval();

    assert.deepEqual(ids(await retrieve('logs')), ['oom-killed', 'crash-loop']);
  });

  it('returns at most 3 entries, best first', async () => {
    const scores = runbookScores({ 'high-latency': 0.77, 'disk-full': 0.78, 'crash-loop': 0.79, 'oom-killed': 0.8 });
    mock.method(globalThis, 'fetch', fakeVoyage(scores));
    const { retrieve } = await freshRetrieval();

    assert.deepEqual(ids(await retrieve('logs')), ['oom-killed', 'crash-loop', 'disk-full']);
  });

  it('returns an empty list when nothing is similar enough', async () => {
    mock.method(globalThis, 'fetch', fakeVoyage(runbookScores({})));
    const { retrieve } = await freshRetrieval();

    assert.deepEqual(await retrieve('INFO GET /api/health 200'), []);
  });

  it('embeds the runbook once and reuses it for later requests', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', fakeVoyage(runbookScores({})));
    const { retrieve } = await freshRetrieval();

    await retrieve('first logs');
    await retrieve('second logs');

    const sent = fetchMock.mock.calls.map((call) => JSON.parse(call.arguments[1].body));
    assert.deepEqual(sent.map((body) => body.input_type), ['document', 'query', 'query']);
    assert.equal(sent[0].input.length, runbook.length); // whole runbook in ONE request
  });

  it('retries building the index after a failure instead of caching it', async () => {
    const voyage = fakeVoyage(runbookScores({ 'oom-killed': 0.8 }));
    let calls = 0;
    mock.method(globalThis, 'fetch', async (url, options) => {
      calls += 1;
      if (calls === 1) return jsonResponse({ detail: 'Voyage is down' }, 500);
      return voyage(url, options);
    });
    const { retrieve } = await freshRetrieval();

    await assert.rejects(retrieve('logs'), { code: 'EMBEDDING_FAILED' });
    assert.deepEqual(ids(await retrieve('logs')), ['oom-killed']);
  });
});
