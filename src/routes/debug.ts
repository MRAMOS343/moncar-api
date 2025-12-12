// src/routes/debug.ts
import express from 'express';
import { requireAuth } from '../middleware/auth';

const router = express.Router();

router.get('/debug/whoami', requireAuth, (req, res) => {
  return res.json({
    ok: true,
    user: (req as any).user,
  });
});

export default router;

