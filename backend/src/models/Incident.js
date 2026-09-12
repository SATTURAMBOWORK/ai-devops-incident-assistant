import mongoose from 'mongoose';

const { Schema } = mongoose;

// Optional numbers. Ranges are enforced here so bad input is rejected at the
// database boundary, not just by the API - defence in depth.
const metricsSchema = new Schema(
  {
    cpuUsage: { type: Number, min: 0, max: 100 },
    memoryUsage: { type: Number, min: 0, max: 100 },
    requestCount: { type: Number, min: 0 },
    errorRate: { type: Number, min: 0, max: 100 },
  },
  { _id: false } // a sub-document, not a record in its own right
);

// What the LLM returns. `enum` on severity means a hallucinated value such as
// "SEVERE" is rejected before it can reach the dashboard.
const analysisSchema = new Schema(
  {
    summary: { type: String, required: true },
    rootCause: { type: String, required: true },
    evidence: [String],
    severity: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      required: true,
    },
    steps: [String],
    confidence: { type: Number, min: 0, max: 100, required: true },
  },
  { _id: false }
);

// Which runbook entries RAG retrieved for this incident, kept so the dashboard
// can show what the answer was grounded in.
const retrievedDocSchema = new Schema(
  { title: String, score: Number },
  { _id: false }
);

// What our own trained classifier predicted (the Python service in ml/).
//
// Stored alongside the LLM's analysis rather than merged into it, so the two
// stay comparable: you can query later for incidents where the model and the
// LLM disagreed, which is exactly the set worth adding to the training data.
//
// Every field is optional - the classifier is allowed to be unavailable or
// unsure, and an incident analysed without it is still a complete incident.
const classificationSchema = new Schema(
  {
    label: String, // runbook category id, e.g. 'oom-killed'
    confidence: { type: Number, min: 0, max: 1 },
    // Runners-up, kept because a 0.45/0.40 split is a meaningfully different
    // answer from a 0.45 with nothing behind it.
    alternatives: [{ _id: false, label: String, confidence: Number }],
    // Which trained model said this. Without it, predictions from different
    // model versions are indistinguishable in the database.
    modelVersion: String,
  },
  { _id: false }
);

const incidentSchema = new Schema(
  {
    title: { type: String, trim: true, maxlength: 200, default: 'Untitled incident' },
    source: { type: String, enum: ['paste', 'upload'], default: 'paste' },

    logs: { type: String, required: true, maxlength: 50000 },
    metrics: metricsSchema,

    // The record is written with status "pending" BEFORE the LLM is called, so a
    // crash mid-analysis leaves a visible failed incident instead of nothing.
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    error: String, // only set when status is "failed"

    analysis: analysisSchema,
    retrievedDocs: [retrievedDocSchema],
    classification: classificationSchema,

    // Cheap observability: what it cost and how long it took.
    model: String,
    tokensUsed: Number,
    durationMs: Number,
  },
  {
    timestamps: true, // adds createdAt / updatedAt automatically
  }
);

// The history page always sorts newest-first. Without this index Mongo sorts in
// memory, which is fine at 50 documents and slow at 50,000.
incidentSchema.index({ createdAt: -1 });

export default mongoose.model('Incident', incidentSchema);
