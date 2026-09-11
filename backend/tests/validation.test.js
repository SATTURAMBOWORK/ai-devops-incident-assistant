import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIncidentSchema,
  listIncidentsSchema,
  incidentIdSchema,
} from '../src/models/incident.validation.js';

// Pure unit tests: the schemas are plain objects, so no server, database or
// network is involved. These run in milliseconds.

// Turn Zod's issue list into "field: message" strings, easy to assert on.
const problems = (result) => result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

describe('createIncidentSchema', () => {
  const { body } = createIncidentSchema;

  it('accepts logs with optional title and metrics', () => {
    const result = body.safeParse({
      title: 'api down',
      logs: 'ECONNREFUSED',
      metrics: { cpuUsage: 50, memoryUsage: 90, requestCount: 1200, errorRate: 5 },
    });
    assert.equal(result.success, true);
  });

  it('trims logs', () => {
    const result = body.safeParse({ logs: '   OOMKilled   ' });
    assert.equal(result.data.logs, 'OOMKilled');
  });

  it('removes fields the client must not set', () => {
    const result = body.safeParse({ logs: 'x', status: 'completed', analysis: { severity: 'LOW' } });
    assert.equal(result.success, true);
    assert.equal(result.data.status, undefined);
    assert.equal(result.data.analysis, undefined);
  });

  it('rejects missing logs', () => {
    const result = body.safeParse({});
    assert.deepEqual(problems(result), ['logs: logs is required']);
  });

  it('rejects logs that are only whitespace', () => {
    const result = body.safeParse({ logs: '    ' });
    assert.deepEqual(problems(result), ['logs: logs cannot be empty']);
  });

  it('rejects logs over 50,000 characters', () => {
    const result = body.safeParse({ logs: 'a'.repeat(50001) });
    assert.deepEqual(problems(result), ['logs: logs cannot be longer than 50,000 characters']);
  });

  it('rejects out-of-range metrics and reports every problem', () => {
    const result = body.safeParse({
      logs: 'x',
      metrics: { cpuUsage: 150, errorRate: -1, requestCount: 2.5 },
    });
    const fields = problems(result).map((p) => p.split(':')[0]);
    assert.deepEqual(fields.sort(), ['metrics.cpuUsage', 'metrics.errorRate', 'metrics.requestCount']);
  });
});

describe('listIncidentsSchema', () => {
  const { query } = listIncidentsSchema;

  it('applies defaults when page and limit are missing', () => {
    assert.deepEqual(query.parse({}), { page: 1, limit: 10 });
  });

  it('turns query-string text into numbers', () => {
    assert.deepEqual(query.parse({ page: '3', limit: '25' }), { page: 3, limit: 25 });
  });

  it('rejects a limit above 50', () => {
    assert.equal(query.safeParse({ limit: '51' }).success, false);
  });

  it('rejects page 0', () => {
    assert.equal(query.safeParse({ page: '0' }).success, false);
  });
});

describe('incidentIdSchema', () => {
  const { params } = incidentIdSchema;

  it('accepts a 24-character hex id', () => {
    assert.equal(params.safeParse({ id: '66e0a1b2c3d4e5f6a7b8c9d0' }).success, true);
  });

  it('rejects a malformed id', () => {
    const result = params.safeParse({ id: '123' });
    assert.deepEqual(problems(result), ['id: id must be a valid incident id']);
  });
});
