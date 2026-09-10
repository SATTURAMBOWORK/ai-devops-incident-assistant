// The exact JSON shape the LLM must return. It is a JSON Schema, not a
// Mongoose schema: Groq enforces it while generating, before we ever see the
// reply. It mirrors analysisSchema in Incident.js, so every analysis the LLM
// produces fits what MongoDB stores.
//
// Groq's strict mode requires every field in `required` and no extra
// properties, so we never get a missing field or a severity like "SEVERE".
export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what happened.' },
    rootCause: { type: 'string', description: 'The most likely underlying cause.' },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific log lines or metric values that support the root cause.',
    },
    severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ordered troubleshooting steps.',
    },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
  },
  required: ['summary', 'rootCause', 'evidence', 'severity', 'steps', 'confidence'],
  additionalProperties: false,
};
