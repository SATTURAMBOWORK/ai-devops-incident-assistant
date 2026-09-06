import { Router } from 'express';

const router = Router();

// GET /api/health
// Docker's HEALTHCHECK and the CI pipeline both hit this. It must stay cheap
// and must never require the LLM or any paid service.
router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
