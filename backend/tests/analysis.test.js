import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeIncident,
  trimLogs,
  MAX_LOG_CHARS,
  ANALYSIS_MODEL,
} from '../src/services/analysis.service.js';
import { ANALYSIS_SCHEMA } from '../src/models/analysis.schema.js';
import { groqResponse, jsonResponse, SAMPLE_ANALYSIS } from './helpers/fakes.js';

// Unit tests for the Groq analysis service. Groq is faked, so we can check both
// what we SEND (prompt, schema, model) and how we handle every kind of reply.

const MATCH = {
  title: 'Container killed: out of memory',
  steps: ['Confirm OOMKilled with docker inspect'],
  score: 0.8,
};

const sentBody = (fetchMock) => JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
const userPrompt = (body) => body.messages.find((m) => m.role === 'user').content;

afterEach(() => mock.restoreAll());

describe('trimLogs', () => {
  it('leaves short logs unchanged', () => {
    assert.equal(trimLogs('OOMKilled'), 'OOMKilled');
  });

  it('keeps the END of long logs and marks the cut', () => {
    const logs = 'old'.repeat(5000) + 'x'.repeat(MAX_LOG_CHARS);
    const trimmed = trimLogs(logs);

    assert.ok(trimmed.startsWith('[... earlier log lines truncated ...]'));
    assert.ok(trimmed.endsWith('x'.repeat(MAX_LOG_CHARS)));
    assert.ok(!trimmed.includes('old'));
  });
});

describe('analyzeIncident', () => {
  it('asks Groq for strict JSON matching the analysis schema', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => groqResponse());

    await analyzeIncident({ logs: 'OOMKilled' });

    const body = sentBody(fetchMock);
    assert.equal(body.model, ANALYSIS_MODEL);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema, ANALYSIS_SCHEMA);
  });

  it('puts logs, metrics and runbook steps into the prompt', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => groqResponse());

    await analyzeIncident({ logs: 'OOMKilled', metrics: { memoryUsage: 98 }, matches: [MATCH] });

    const prompt = userPrompt(sentBody(fetchMock));
    assert.ok(prompt.includes('Memory usage: 98%'));
    assert.ok(prompt.includes(MATCH.title));
    assert.ok(prompt.includes('- Confirm OOMKilled with docker inspect'));
    assert.ok(prompt.includes('<logs>\nOOMKilled\n</logs>'));
  });

  it('tells the model when there are no metrics or runbook matches', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => groqResponse());

    await analyzeIncident({ logs: 'OOMKilled' });

    const prompt = userPrompt(sentBody(fetchMock));
    assert.ok(prompt.includes('No metrics provided.'));
    assert.ok(prompt.includes('No matching runbook entries'));
  });

  it('returns the parsed analysis, model and token count', async () => {
    mock.method(globalThis, 'fetch', async () => groqResponse());

    const result = await analyzeIncident({ logs: 'OOMKilled' });

    assert.deepEqual(result, {
      analysis: SAMPLE_ANALYSIS,
      model: 'openai/gpt-oss-120b',
      tokensUsed: 1000,
    });
  });

  it('fails with ANALYSIS_FAILED when Groq returns an error status', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'rate limited' }, 429));

    await assert.rejects(analyzeIncident({ logs: 'x' }), {
      code: 'ANALYSIS_FAILED',
      statusCode: 502,
      message: /429/,
    });
  });

  it('fails clearly when the reply was cut off', async () => {
    mock.method(globalThis, 'fetch', async () => groqResponse('{"summary": "half an obj', { finishReason: 'length' }));

    await assert.rejects(analyzeIncident({ logs: 'x' }), { code: 'ANALYSIS_FAILED', message: /cut off/ });
  });

  it('fails clearly when the reply is not valid JSON', async () => {
    mock.method(globalThis, 'fetch', async () => groqResponse('this is not json'));

    await assert.rejects(analyzeIncident({ logs: 'x' }), { code: 'ANALYSIS_FAILED', message: /not valid JSON/ });
  });

  it('fails with ANALYSIS_FAILED when Groq is unreachable', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });

    await assert.rejects(analyzeIncident({ logs: 'x' }), { code: 'ANALYSIS_FAILED', message: /unreachable/ });
  });
});
