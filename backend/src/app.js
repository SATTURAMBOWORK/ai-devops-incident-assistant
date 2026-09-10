import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import healthRoutes from './routes/health.routes.js';
import incidentRoutes from './routes/incident.routes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

// This file only WIRES the app together - it never listens on a port and never
// connects to a database. That is what lets tests import it directly and make
// requests against it in-process, with no server running.
const app = express();

app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json({ limit: '2mb' })); // logs can be large, but not unbounded

app.use('/api/health', healthRoutes);
app.use('/api/incidents', incidentRoutes);

// Order matters: these must come after every route.
app.use(notFound);
app.use(errorHandler);

export default app;
