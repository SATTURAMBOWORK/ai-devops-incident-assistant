import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import {
  createIncidentSchema,
  listIncidentsSchema,
  incidentIdSchema,
} from '../models/incident.validation.js';
import { createIncident, listIncidents, getIncident } from '../controllers/incident.controller.js';

// URL -> validation -> controller. Reading this file tells you the whole
// incident API at a glance. Mounted at /api/incidents in app.js.
const router = Router();

router.post('/', validate(createIncidentSchema), createIncident);
router.get('/', validate(listIncidentsSchema), listIncidents);
router.get('/:id', validate(incidentIdSchema), getIncident);

export default router;
