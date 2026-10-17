import { Router } from 'express';
import { postChallenge, postVerify } from '../controllers/auth.controller';
import { authLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// No Idempotency-Key here (#123): /challenge is harmless to repeat, and
// /verify returns a JWT that must never be stored for replay (its GETDEL
// challenge already makes a duplicate fail with CHALLENGE_NOT_FOUND).
router.post('/challenge', authLimiter, postChallenge);
router.post('/verify', authLimiter, postVerify);

export default router;
