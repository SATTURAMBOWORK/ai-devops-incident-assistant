import { z } from 'zod';

// What a valid request looks like, for each incident endpoint.
//
// Each export describes the parts of the request it checks: `body`, `query`
// and/or `params`. The validate middleware runs these before the controller,
// so a controller only ever sees input that has already passed.
//
// The limits match models/Incident.js. The API rejects bad input with a clear
// 400; the Mongoose schema is a second check at the database (defence in depth).

const percent = z.number().min(0).max(100);

// POST /api/incidents
export const createIncidentSchema = {
  body: z.object({
    title: z.string().trim().max(200).optional(),
    logs: z
      .string({ message: 'logs is required' })
      .trim()
      .min(1, 'logs cannot be empty')
      .max(50000, 'logs cannot be longer than 50,000 characters'),
    // Every metric is optional - users often only have logs.
    metrics: z
      .object({
        cpuUsage: percent.optional(),
        memoryUsage: percent.optional(),
        requestCount: z.number().int().min(0).optional(),
        errorRate: percent.optional(),
      })
      .optional(),
  }),
  // z.object drops unknown fields, so a client cannot sneak in something like
  // `status: "completed"` or a fake `analysis` - those are set by the server.
};

// GET /api/incidents?page=1&limit=10
export const listIncidentsSchema = {
  query: z.object({
    // Query strings are always text ("2"), so coerce them to numbers.
    page: z.coerce.number().int().min(1).default(1),
    // Capped so one request cannot pull the whole collection.
    limit: z.coerce.number().int().min(1).max(50).default(10),
  }),
};

// GET /api/incidents/:id
export const incidentIdSchema = {
  params: z.object({
    // A MongoDB ObjectId is 24 hex characters. Checking here turns a malformed
    // id into a 400, instead of a Mongoose CastError surfacing as a 500.
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'id must be a valid incident id'),
  }),
};
