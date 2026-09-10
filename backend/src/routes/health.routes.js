import { Router } from 'express';
import { getDBState } from '../config/db.js';

const router = Router();

// GET /api/health
// Docker's HEALTHCHECK and the CI pipeline both hit this. It stays cheap and
// deliberately never touches the LLM - a health check must not cost money.
router.get('/', (req, res) => {
  const database = getDBState();
  const healthy = database === 'connected';

  // 503, not 200, when the database is down. An orchestrator reads the status
  // code: it will restart the container or stop routing traffic to it. Returning
  // 200 with {status:"degraded"} would look fine and silently serve errors.
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    data: {
      status: healthy ? 'ok' : 'degraded',
      database,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
