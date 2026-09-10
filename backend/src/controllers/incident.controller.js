import * as incidentService from '../services/incident.service.js';

// Controllers translate between HTTP and the service: take validated input off
// the request, call the service, shape the response. No business logic here.
//
// No try/catch and no asyncHandler wrapper: Express 5 automatically passes a
// rejected promise from an async handler to the error middleware.

// POST /api/incidents
export async function createIncident(req, res) {
  const incident = await incidentService.createIncident(req.validated.body);
  res.status(201).json({ success: true, data: incident });
}

// GET /api/incidents?page=1&limit=10
export async function listIncidents(req, res) {
  const result = await incidentService.listIncidents(req.validated.query);
  res.json({ success: true, data: result });
}

// GET /api/incidents/:id
export async function getIncident(req, res) {
  const incident = await incidentService.getIncident(req.validated.params.id);
  res.json({ success: true, data: incident });
}
