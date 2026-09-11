import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';
import Incident from '../src/models/Incident.js';
import {
  fakeVoyage,
  runbookScores,
  groqResponse,
  jsonResponse,
  SAMPLE_ANALYSIS,
} from './helpers/fakes.js';

// Integration tests: real HTTP requests (supertest) through the real Express
// app, routes, validation, controller, service and Mongoose - against a real,
// temporary in-memory MongoDB. Only the paid external APIs are faked.

const OOM_LOGS = 'FATAL ERROR: JavaScript heap out of memory\ncontainer api-1 exited with code 137';
const voyage = fakeVoyage(runbookScores({ 'oom-killed': 0.8 }));

// Route each outgoing fetch to the right fake by URL. A test can swap in a
// failing Groq (or Voyage) to exercise the error path.
function mockExternalApis({ groq = async () => groqResponse(), embed = voyage } = {}) {
  return mock.method(globalThis, 'fetch', async (url, options) =>
    url.includes('voyageai') ? embed(url, options) : groq(url, options)
  );
}

let mongod;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Incident.deleteMany({}); // every test starts from an empty collection
  // The error handler logs 4xx/5xx responses - expected here, so keep output clean.
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});

afterEach(() => mock.restoreAll());

describe('POST /api/incidents', () => {
  it('analyzes logs and saves a completed incident', async () => {
    mockExternalApis();

    const res = await request(app)
      .post('/api/incidents')
      .send({ title: 'api crash', logs: OOM_LOGS, metrics: { memoryUsage: 98 } });

    assert.equal(res.status, 201);
    const incident = res.body.data;
    assert.equal(incident.status, 'completed');
    assert.deepEqual(incident.analysis, SAMPLE_ANALYSIS);
    assert.deepEqual(incident.retrievedDocs, [{ title: 'Container killed: out of memory', score: 0.8 }]);
    assert.equal(incident.model, 'openai/gpt-oss-120b');
    assert.equal(incident.tokensUsed, 1000);
    assert.equal(typeof incident.durationMs, 'number');

    // It really is in the database, with the full original logs.
    const saved = await Incident.findById(incident._id).lean();
    assert.equal(saved.status, 'completed');
    assert.equal(saved.logs, OOM_LOGS);
  });

  it('saves a failed incident when the LLM call fails', async () => {
    mockExternalApis({ groq: async () => jsonResponse({ error: 'rate limited' }, 429) });

    const res = await request(app).post('/api/incidents').send({ logs: OOM_LOGS });

    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'ANALYSIS_FAILED');

    const [saved] = await Incident.find().lean();
    assert.equal(saved.status, 'failed');
    assert.match(saved.error, /429/);
    assert.equal(saved.analysis, undefined);
  });

  it('saves a failed incident and skips the LLM when embedding fails', async () => {
    const fetchMock = mockExternalApis({ embed: async () => jsonResponse({ detail: 'down' }, 500) });

    const res = await request(app).post('/api/incidents').send({ logs: OOM_LOGS });

    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'EMBEDDING_FAILED');
    const [saved] = await Incident.find().lean();
    assert.equal(saved.status, 'failed');

    const calledGroq = fetchMock.mock.calls.some((call) => call.arguments[0].includes('groq'));
    assert.equal(calledGroq, false);
  });

  it('rejects invalid input without saving anything or calling any API', async () => {
    const fetchMock = mockExternalApis();

    const res = await request(app)
      .post('/api/incidents')
      .send({ logs: '   ', metrics: { cpuUsage: 150 } });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.match(res.body.error.message, /logs cannot be empty/);
    assert.match(res.body.error.message, /metrics\.cpuUsage/);
    assert.equal(await Incident.countDocuments(), 0);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

describe('GET /api/incidents', () => {
  // Insert straight through the MongoDB driver so we control createdAt exactly.
  async function seedIncidents() {
    const docs = ['first', 'second', 'third'].map((title, i) => ({
      title,
      logs: `logs for ${title}`,
      status: 'completed',
      analysis: SAMPLE_ANALYSIS,
      createdAt: new Date(2026, 0, i + 1),
      updatedAt: new Date(2026, 0, i + 1),
    }));
    const { insertedIds } = await Incident.collection.insertMany(docs);
    return Object.values(insertedIds).map(String);
  }

  it('lists incidents newest first, paginated, without the full logs', async () => {
    await seedIncidents();

    const page1 = await request(app).get('/api/incidents?page=1&limit=2');
    assert.equal(page1.status, 200);
    assert.deepEqual(page1.body.data.items.map((i) => i.title), ['third', 'second']);
    assert.equal(page1.body.data.total, 3);
    assert.equal(page1.body.data.totalPages, 2);
    assert.equal(page1.body.data.items[0].logs, undefined);
    assert.equal(page1.body.data.items[0].analysis.severity, 'HIGH');

    const page2 = await request(app).get('/api/incidents?page=2&limit=2');
    assert.deepEqual(page2.body.data.items.map((i) => i.title), ['first']);
  });

  it('returns one incident with everything by id', async () => {
    const [firstId] = await seedIncidents();

    const res = await request(app).get(`/api/incidents/${firstId}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.title, 'first');
    assert.equal(res.body.data.logs, 'logs for first');
    assert.deepEqual(res.body.data.analysis, SAMPLE_ANALYSIS);
  });

  it('returns 400 for a malformed id', async () => {
    const res = await request(app).get('/api/incidents/123');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for an id that does not exist', async () => {
    const res = await request(app).get('/api/incidents/000000000000000000000000');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
