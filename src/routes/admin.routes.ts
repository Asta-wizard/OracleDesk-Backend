import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middlewares/auth.middleware';
import {
  addOperationSignature,
  cancelTreasuryOperation,
  createOperation,
  getTreasury,
  getTreasuryOperation,
  listTreasuryOperations,
  recordTreasuryOperation,
  submitTreasuryOperation,
} from '../controllers/admin.controller';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/treasury', getTreasury);
router.get('/treasury/operations', listTreasuryOperations);
router.post('/treasury/operations', createOperation);
router.get('/treasury/operations/:id', getTreasuryOperation);
router.post('/treasury/operations/:id/signatures', addOperationSignature);
router.post('/treasury/operations/:id/submit', submitTreasuryOperation);
router.post('/treasury/operations/:id/record', recordTreasuryOperation);
router.post('/treasury/operations/:id/cancel', cancelTreasuryOperation);

export default router;
