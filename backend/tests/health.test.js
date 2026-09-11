import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app.js';

// The health check is what Docker's HEALTHCHECK and the deploy platform will
// poll, so its status CODE matters, not just the body.

let mongod;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('GET /api/health', () => {
  it('returns 200 when the database is connected', async () => {
    const res = await request(app).get('/api/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'ok');
    assert.equal(res.body.data.database, 'connected');
  });

  it('returns 503 when the database is disconnected', async () => {
    await mongoose.disconnect();

    const res = await request(app).get('/api/health');

    assert.equal(res.status, 503);
    assert.equal(res.body.data.status, 'degraded');
    assert.equal(res.body.data.database, 'disconnected');
  });

  it('returns 404 JSON for an unknown route', async () => {
    const res = await request(app).get('/api/does-not-exist');

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
