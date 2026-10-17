import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middlewares/auth.middleware';
import { getTraceAuditSummary, triggerTraceAuditRun, getSystemStatus } from '../controllers/admin.controller';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/status', getSystemStatus);
router.get('/trace-audit', getTraceAuditSummary);
router.post('/trace-audit/run', triggerTraceAuditRun);

export default router;
