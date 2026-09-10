import Incident from '../models/Incident.js';
import { retrieve } from './retrieval.service.js';
import { analyzeIncident, trimLogs } from './analysis.service.js';
import { AppError } from '../middleware/errorHandler.js';
import logger from '../utils/logger.js';

// The incident workflow. This file knows the ORDER of things - save, retrieve,
// analyze, save again - but nothing about HTTP (no req, no res). That is what
// lets tests call it directly, and would let a CLI or a queue worker reuse it.

/**
 * Analyze logs and store the result.
 * Throws if retrieval or analysis fails - but the incident is still saved as
 * "failed" first, so the attempt shows up in history.
 */
export async function createIncident({ title, logs, metrics }) {
  // 1. Save BEFORE calling any external API. If Voyage or Groq fails - or the
  //    process crashes - there is a record of the attempt, not silence.
  const incident = await Incident.create({ title, logs, metrics, status: 'pending' });
  const startedAt = Date.now();

  try {
    // 2. Trim once and use the same text for both calls: Voyage allows 10K
    //    tokens/min and Groq 8K, and 50,000 characters would exceed both.
    //    The full original logs stay stored on the incident.
    const trimmedLogs = trimLogs(logs);

    // 3. Retrieve: which runbook entries match these logs? (the R in RAG)
    const matches = await retrieve(trimmedLogs);

    // 4. Analyze: logs + metrics + matched runbook steps -> structured JSON.
    const { analysis, model, tokensUsed } = await analyzeIncident({
      logs: trimmedLogs,
      metrics,
      matches,
    });

    // 5. Save the result. Only title + score of each match are stored - the
    //    steps already live in runbook.js, no need to copy them into every record.
    incident.set({
      status: 'completed',
      analysis,
      retrievedDocs: matches.map(({ title: docTitle, score }) => ({ title: docTitle, score })),
      model,
      tokensUsed,
      durationMs: Date.now() - startedAt,
    });
    await incident.save();
    return incident;
  } catch (err) {
    incident.set({ status: 'failed', error: err.message, durationMs: Date.now() - startedAt });
    // If even this save fails (database down), log it but still report the
    // ORIGINAL error - that is the one the user needs to see.
    await incident.save().catch((saveErr) =>
      logger.error(`Could not mark incident ${incident.id} as failed:`, saveErr.message)
    );
    throw err;
  }
}

/**
 * One page of incidents, newest first. Light fields only - the full logs and
 * analysis can be large, and the history list does not need them.
 */
export async function listIncidents({ page, limit }) {
  const [items, total] = await Promise.all([
    Incident.find()
      .sort({ createdAt: -1 }) // uses the createdAt index from Incident.js
      .skip((page - 1) * limit)
      .limit(limit)
      .select('title status analysis.summary analysis.severity durationMs createdAt')
      .lean(), // plain objects instead of Mongoose documents: faster for read-only data
    Incident.countDocuments(),
  ]);

  return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
}

/** One incident with everything: logs, metrics, analysis, retrieved docs. */
export async function getIncident(id) {
  const incident = await Incident.findById(id).lean();
  if (!incident) {
    throw new AppError(`Incident not found: ${id}`, 404, 'NOT_FOUND');
  }
  return incident;
}
